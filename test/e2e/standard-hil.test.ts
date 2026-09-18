import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';

describe('standard pipeline with HIL (fake runner)', () => {
  it('refine → plan → approve_plan(request_changes resumes plan) → implement → test → review → approve_result(request_changes → implement) → approve', async () => {
    const dir = tmpDir('sdlc-hil-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n', 'test.js': "console.log('ok')\n" }, 'test_command: node test.js\n');
    const calls: string[] = [];
    const runner = new FakeRunner((spec) => ({
      act: () => {
        const p = spec.prompt;
        if (p.includes('Phase: clarify')) { calls.push('clarify'); return { structured: { questions: [{ question: 'Which file?', header: 'File', options: ['a.txt'] }], suggestedPrompt: 'Change a.txt from x to y', assumptions: ['only a.txt'] } }; }
        if (p.includes('Phase: plan')) { calls.push('plan'); fs.mkdirSync(path.join(spec.cwd, '.sdlc'), { recursive: true }); fs.writeFileSync(path.join(spec.cwd, '.sdlc/plan.md'), '# Plan v1\n'); return { text: 'plan summary v1' }; }
        if (p.includes('requested changes') && p.includes('plan.md')) { calls.push('plan-resume:' + spec.resume); fs.writeFileSync(path.join(spec.cwd, '.sdlc/plan.md'), '# Plan v2\n'); return { text: 'plan summary v2' }; }
        if (p.includes('Phase: implement')) { calls.push('implement'); expect(p).toContain('# Plan v2 (edited)'); fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'y\n'); return { text: 'implemented' }; }
        if (p.includes('reviewed the result and requested changes')) { calls.push('implement-resume:' + spec.resume); fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'z\n'); return { text: 'fixed per human' }; }
        if (p.includes('Phase: test')) { calls.push('test'); return { structured: { verdict: 'pass', summary: 'ok', commands: ['node test.js'], tests_added: [], failures: [], notes: '' } }; }
        if (p.includes('Phase: review')) { calls.push('review'); return { structured: { verdict: 'approve', summary: 'fine', findings: [] } }; }
        if (p.includes('Phase: QA')) { calls.push('qa'); return { structured: { verdict: 'pass', summary: 'works', checks: [{ name: 'smoke', method: 'node test.js', result: 'ok' }], issues: [] } }; }
        throw new Error('unexpected prompt: ' + p.slice(0, 100));
      },
    }));
    const app = testApp(dir, runner);
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'standard', baseRemote: null });
    await app.engine.advance(task.id);

    // 1. refine HIL with clarify output
    let hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.kind).toBe('refine_prompt');
    expect(hil.payload.kind === 'refine_prompt' && hil.payload.questions.length).toBe(1);
    await app.engine.respondHil(hil.id, { decision: 'approve', edited: { prompt: 'Change a.txt from x to y (file: a.txt)' } }, 'web');
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.refinedPrompt).toBe('Change a.txt from x to y (file: a.txt)');

    // 2. approve_plan → request changes → plan resumed in same session
    hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.kind).toBe('approve_plan');
    expect(hil.payload.kind === 'approve_plan' && hil.payload.planMd).toBe('# Plan v1\n');
    await expect(app.engine.respondHil(hil.id, { decision: 'request_changes' }, 'web')).rejects.toThrow(/comment is required/);
    await app.engine.respondHil(hil.id, { decision: 'request_changes', comment: 'do it differently' }, 'web');
    await app.engine.advance(task.id);
    hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.kind).toBe('approve_plan');
    expect(hil.payload.kind === 'approve_plan' && hil.payload.planMd).toBe('# Plan v2\n');
    expect(calls.filter((c) => c.startsWith('plan-resume:fake-session-')).length).toBe(1);

    // 3. approve plan with an edit → implement gets edited plan
    await app.engine.respondHil(hil.id, { decision: 'approve', edited: { planMd: '# Plan v2 (edited)\n' } }, 'web');
    await app.engine.advance(task.id);

    // 4. approve_result → request changes → implement resumed → back to approve_result
    hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.kind).toBe('approve_result');
    expect(hil.payload.kind === 'approve_result' && hil.payload.commits.length).toBe(1);
    expect(hil.payload.kind === 'approve_result' && hil.payload.review?.verdict).toBe('approve');
    expect(hil.payload.kind === 'approve_result' && hil.payload.test?.verdict).toBe('pass');
    expect(hil.payload.kind === 'approve_result' && hil.payload.testOutput).toMatch(/^pass: ok/);
    await app.engine.respondHil(hil.id, { decision: 'request_changes', comment: 'make it z' }, 'web');
    await app.engine.advance(task.id);
    hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.kind).toBe('approve_result');
    expect(hil.payload.kind === 'approve_result' && hil.payload.commits.length).toBe(2);
    expect(calls.some((c) => c.startsWith('implement-resume:fake-session-'))).toBe(true);

    // 5. approve → pr phase fails (no gh/remote) → escalation with skip
    await app.engine.respondHil(hil.id, { decision: 'approve' }, 'web');
    await app.engine.advance(task.id);
    const t = app.store.getTask(task.id)!;
    hil = app.store.openHilForTask(task.id)[0]!;
    expect(t.status).toBe('waiting_hil');
    expect(hil.kind).toBe('escalation');
    expect(hil.payload.kind === 'escalation' && hil.payload.phaseName).toBe('pr');
    await app.engine.respondHil(hil.id, { decision: 'skip' }, 'web');
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');
    // qa ran (best effort), qa_report skipped (no PR), qa_gate skipped (no issues)
    const byName = Object.fromEntries(app.store.phaseRunsForTask(task.id).map((p) => [p.phaseName, p.status]));
    expect(byName.qa).toBe('succeeded'); expect(byName.qa_report).toBe('skipped'); expect(byName.qa_gate).toBe('skipped');
    expect(calls).toEqual(['clarify', 'plan', expect.stringMatching(/^plan-resume:/), 'implement', 'test', 'review', expect.stringMatching(/^implement-resume:/), 'test', 'review', 'qa']);
  });

  it('abort from HIL cancels the task and removes the worktree', async () => {
    const dir = tmpDir('sdlc-abort-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const runner = new FakeRunner(() => ({ act: () => ({ structured: { questions: [], suggestedPrompt: 'p', assumptions: [] } }) }));
    const app = testApp(dir, runner, { cleanup: 'on_pr' });
    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'standard', baseRemote: null });
    await app.engine.advance(task.id);
    const hil = app.store.openHilForTask(task.id)[0]!;
    await app.engine.respondHil(hil.id, { decision: 'abort' }, 'web');
    await new Promise((r) => setTimeout(r, 300));
    expect(app.store.getTask(task.id)!.status).toBe('aborted');
    expect(app.store.getHil(hil.id)!.status).toBe('answered');
    expect(fs.existsSync(task.worktreePath)).toBe(false);
  });
});
