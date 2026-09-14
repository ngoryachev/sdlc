import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe('controls: pause / resume / inject / abort / recover', () => {
  it('pause interrupts a running phase; resume continues the same session with guidance; inject reaches the session', async () => {
    const dir = tmpDir('sdlc-ctl-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    let release: (() => void) | null = null;
    const prompts: { prompt: string; resume?: string; injected: string[] }[] = [];
    const runner = new FakeRunner((spec) => ({
      act: async (_s, api) => {
        if (spec.prompt.includes('implement') && !spec.resume) {
          await new Promise<void>((r) => { release = r; }); // hang until paused
          prompts.push({ prompt: spec.prompt, resume: spec.resume, injected: api.injected });
          return { text: 'interrupted' };
        }
        prompts.push({ prompt: spec.prompt, resume: spec.resume, injected: api.injected });
        if (spec.prompt.includes('review')) return { structured: { verdict: 'approve', summary: 'ok', findings: [] } };
        fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'y\n');
        return { text: 'done' };
      },
    }));
    const app = testApp(dir, runner);
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'auto', baseRemote: null });
    await tick(200); // implement is now hanging
    expect(app.engine.inject(task.id, 'hint while running').deliveredTo).toBe('session');
    const pausing = app.engine.pause(task.id);
    await tick(50);
    release!();
    await pausing;
    await app.engine.advance(task.id);
    let t = app.store.getTask(task.id)!;
    expect(t.status).toBe('paused');
    const paused = app.store.phaseRunsForTask(task.id).find((p) => p.phaseName === 'implement')!;
    expect(paused.status).toBe('paused');
    expect(paused.sessionId).toBe('fake-session-1');
    expect(prompts[0]!.injected).toEqual(['hint while running']);

    expect(app.engine.inject(task.id, 'queued hint').deliveredTo).toBe('queued');
    await app.engine.resume(task.id, 'carry on');
    await app.engine.advance(task.id);
    t = app.store.getTask(task.id)!;
    expect(t.status).toBe('succeeded');
    const resumed = prompts.find((p) => p.resume === 'fake-session-1')!;
    expect(resumed.prompt).toContain('carry on');
    expect(resumed.prompt).toContain('queued hint');
  });

  it('abort while running marks the task aborted and cleans up', async () => {
    const dir = tmpDir('sdlc-abort2-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    let release: (() => void) | null = null;
    const runner = new FakeRunner(() => ({ act: async () => { await new Promise<void>((r) => { release = r; }); return { text: 'x' }; } }));
    const app = testApp(dir, runner);
    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'auto', baseRemote: null });
    await tick(200);
    const aborting = app.engine.abort(task.id);
    await tick(50); release!();
    await aborting; await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.status).toBe('aborted');
    await tick(300);
    expect(fs.existsSync(task.worktreePath)).toBe(false);
  });

  it('recover() parks running phases as paused and auto-resumes them', async () => {
    const dir = tmpDir('sdlc-recover-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const seen: { resume?: string }[] = [];
    const runner = new FakeRunner((spec) => ({ act: () => { seen.push({ resume: spec.resume }); if (spec.prompt.includes('review')) return { structured: { verdict: 'approve', summary: 'ok', findings: [] } }; fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'y\n'); return { text: 'ok' }; } }));
    const app = testApp(dir, runner);
    // simulate a crash: a task whose implement phase is "running" with a session id
    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'auto', baseRemote: null });
    await app.engine.advance(task.id);
    const run = app.store.latestRunForTask(task.id)!; run.status = 'running'; run.cursor = 0; app.store.updateRun(run);
    const impl = app.store.phaseRunsForTask(task.id).find((p) => p.phaseName === 'implement')!; impl.status = 'running'; app.store.updatePhaseRun(impl);
    const t0 = app.store.getTask(task.id)!; t0.status = 'running'; app.store.updateTask(t0);
    seen.length = 0;
    await app.engine.recover();
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');
    expect(seen[0]!.resume).toBe(impl.sessionId); // resumed the interrupted session
  });
});
