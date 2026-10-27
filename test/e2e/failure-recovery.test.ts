import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';
import { tasksRoutes } from '../../server/src/http/routes/tasks.js';
import type { ClaudeRunSpec } from '../../server/src/claude/runner.js';

type Turn = ReturnType<ConstructorParameters<typeof FakeRunner>[0]>['act'] extends (...a: never[]) => infer R ? Awaited<R> : never;

/** auto pipeline; `test` and `implement` are scripted per call, everything else passes. */
function scripted(test: (n: number, spec: ClaudeRunSpec) => Turn, implement: (n: number, spec: ClaudeRunSpec) => Turn = () => ({ text: 'ok' })) {
  let tests = 0; let impls = 0;
  return new FakeRunner((spec) => ({
    act: () => {
      const p = spec.prompt;
      if (p.includes('Phase: self_check')) return { text: 'checked' };
      if (p.includes('Phase: test')) return test(++tests, spec);
      if (p.includes('Phase: review')) return { structured: { verdict: 'approve', summary: 'ok', findings: [] } };
      if (p.includes('Phase: QA')) return { structured: { verdict: 'pass', summary: 'ok', checks: [], issues: [] } };
      fs.writeFileSync(path.join(spec.cwd, 'a.txt'), `y${impls}\n`);
      return implement(++impls, spec);
    },
  }));
}
const testPass: Turn = { structured: { verdict: 'pass', summary: 'ok', commands: [], tests_added: [], failures: [], notes: '' } };

describe('failures that used to end a task for good', () => {
  it('a test phase that fails without a report still loops back to implement, with its error as the feedback', async () => {
    const dir = tmpDir('sdlc-noreport-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const runner = scripted((n) => (n === 1 ? { subtype: 'error_during_execution' } : testPass));
    const app = testApp(dir, runner);
    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'auto', baseRemote: null });
    await app.engine.advance(task.id);
    expect(runner.specs.some((s) => s.resume && s.prompt === 'Phase test failed without a usable report: fake failure')).toBe(true);
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');
  });

  it('a phase stopped by its cap escalates instead of looping back; resume continues the same session', async () => {
    const dir = tmpDir('sdlc-capped-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const runner = scripted((n) => (n === 1 ? { subtype: 'error_max_budget_usd' } : testPass));
    const app = testApp(dir, runner, { limits: { phases: 'pipeline' } });
    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'auto', baseRemote: null });
    await app.engine.advance(task.id);
    const hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.kind).toBe('escalation');
    expect(hil.payload.kind === 'escalation' && [hil.payload.phaseName, hil.payload.resultSubtype]).toEqual(['test', 'error_max_budget_usd']);
    expect(runner.specs.filter((s) => s.prompt.includes('Phase: implement')).length).toBe(1);   // no loop back
    const capped = app.store.phaseRunsForRun(app.store.latestRunForTask(task.id)!.id).find((p) => p.phaseName === 'test')!;
    await app.engine.respondHil(hil.id, { decision: 'resume' }, 'web');
    await app.engine.advance(task.id);
    expect(runner.specs.at(-3)!.resume).toBe(capped.sessionId);   // test resumed, then review and qa
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');
  });

  it('an error inside the engine stops the task at an escalation, and retry carries on', async () => {
    const dir = tmpDir('sdlc-engine-error-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const app = testApp(dir, scripted(() => testPass));
    const insert = app.store.insertPhaseRun.bind(app.store);
    let thrown = false;
    vi.spyOn(app.store, 'insertPhaseRun').mockImplementation((pr) => {
      if (pr.phaseName === 'test' && !thrown) { thrown = true; throw new Error('boom'); }
      return insert(pr);
    });
    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'auto', baseRemote: null });
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.status).toBe('waiting_hil');
    const hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.kind).toBe('escalation');
    expect(hil.payload.kind === 'escalation' && hil.payload.error).toBe('sdlc error: boom');
    await app.engine.respondHil(hil.id, { decision: 'retry' }, 'web');
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');
  });

  it('a failed task is retried over HTTP at the phase it stopped on, continuing its session with guidance', async () => {
    const dir = tmpDir('sdlc-retry-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    let broken = true;
    const runner = scripted(() => testPass, () => (broken ? { subtype: 'error_during_execution' } : { text: 'ok' }));
    const app = testApp(dir, runner);
    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'auto', baseRemote: null });
    await app.engine.advance(task.id);   // implement: retry 1, then fail
    expect(app.store.getTask(task.id)!.status).toBe('failed');
    await expect(app.engine.retry('nope')).rejects.toThrow(/not found/);
    const failed = app.store.latestPhaseRun(app.store.latestRunForTask(task.id)!.id, 'implement', ['failed'])!;

    broken = false;
    const hono = new Hono().route('/api', tasksRoutes(app));
    const res = await hono.request(`/api/tasks/${task.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resume: true, guidance: 'go on' }) });
    expect(res.status).toBe(200);
    await app.engine.advance(task.id);
    const resumed = runner.specs.find((s) => s.prompt === 'go on')!;
    expect(resumed.resume).toBe(failed.sessionId);
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');
    await expect(app.engine.retry(task.id)).rejects.toThrow(/only a failed task/);
  });

  it('phase caps are read from the pipeline file when the phase starts, not from the task snapshot', async () => {
    const dir = tmpDir('sdlc-live-limits-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const root = path.join(dir, 'sdlc');
    fs.mkdirSync(path.join(root, 'pipelines'), { recursive: true }); fs.mkdirSync(path.join(root, 'prompts/system'), { recursive: true });
    fs.writeFileSync(path.join(root, 'prompts/work.md'), '# Phase: work\n');
    fs.writeFileSync(path.join(root, 'prompts/system/common.md'), '');
    const yaml = (budget: number) => `name: live\nphases:\n  - name: work\n    type: claude\n    prompt: prompts/work.md\n    max_turns: 3\n    max_budget_usd: ${budget}\n`;
    const file = path.join(root, 'pipelines/live.yaml');
    fs.writeFileSync(file, yaml(1));
    const runner = new FakeRunner(() => ({ act: () => ({ text: 'ok' }) }));
    const app = testApp(dir, runner, { pipelines_dirs: [path.join(root, 'pipelines')], limits: { phases: 'pipeline' } });
    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'live', baseRemote: null });
    fs.writeFileSync(file, yaml(7));   // raised after the task took its snapshot
    await app.engine.advance(task.id);
    expect([runner.specs[0]!.maxTurns, runner.specs[0]!.maxBudgetUsd]).toEqual([3, 7]);
  });
});
