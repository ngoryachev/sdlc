import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import type { HilPayload } from '@sdlc/shared';
import { HUMAN_ADDITIONS_HEADING } from '@sdlc/shared';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';
import { hilRoutes } from '../../server/src/http/routes/hil.js';
import { HttpError } from '../../server/src/engine/engine.js';
import { newHilRequest } from '../../server/src/phases/hil.js';

const withErrors = (hono: Hono) => hono.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message, ...err.extra }, err.status as 400) : c.json({ error: err.message }, 500)));

/** A checkpoint planted on a quick-pipeline task (no plan phase): the decisions that do deliver a comment must still pass. */
async function planted(payload: HilPayload) {
  const dir = tmpDir('sdlc-hil-comment-paths-');
  const repo = makeRepo(dir, { 'a.txt': 'x\n' });
  const runner = new FakeRunner(() => ({ act: () => ({ structured: { questions: [{ question: 'Which file?', header: 'File' }], suggestedPrompt: 'p', assumptions: [] } }) }));
  const app = testApp(dir, runner);
  const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'quick', baseRemote: null });
  await app.engine.advance(task.id);
  const hil = newHilRequest({ taskId: task.id, phaseRunId: null, kind: payload.kind, title: 't', summary: 's', payload });
  app.store.insertHil(hil);
  const hono = withErrors(new Hono().route('/api', hilRoutes(app)));
  const post = (body: unknown) => hono.request(`/api/hil/${hil.id}/respond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { app, hil, post, runner, task };
}

describe('comments on the decisions that deliver them are accepted and reach the agent', () => {
  it('escalation resume with a comment: 200, the phase resumes with the comment as its feedback', async () => {
    const { app, hil, post, runner } = await planted({ kind: 'escalation', phaseName: 'implement', error: 'boom', resultSubtype: null });
    const res = await post({ decision: 'resume', comment: 'use the helper in utils.ts' });
    expect(res.status).toBe(200);
    expect(app.store.getHil(hil.id)!.status).toBe('answered');
    await app.engine.advance(hil.taskId);
    expect(runner.specs.some((s) => s.prompt.includes('use the helper in utils.ts'))).toBe(true);
  });

  it('approve_plan request_changes with a comment is not refused for a missing plan artifact (only approve needs it)', async () => {
    const { app, hil, post } = await planted({ kind: 'approve_plan', planMd: '# P\n', summary: 's', costUsd: 0 });
    const res = await post({ decision: 'request_changes', comment: 'split it in two steps' });
    expect(res.status).toBe(200);
    expect(app.store.getHil(hil.id)!.status).toBe('answered');
  });

  it('approve_plan approve without a comment and no plan artifact still goes through', async () => {
    const { app, hil, post } = await planted({ kind: 'approve_plan', planMd: '# P\n', summary: 's', costUsd: 0 });
    expect((await post({ decision: 'approve' })).status).toBe(200);
    expect(app.store.getHil(hil.id)!.status).toBe('answered');
  });

  it('approve_result request_changes with only a comment (canFix, nothing to post) sends the comment to the implementer', async () => {
    const { app, hil, post, runner } = await planted({ kind: 'approve_result', diffStat: '', diff: '', testOutput: null, test: null, review: { verdict: 'approve', summary: 'ok', findings: [] }, qa: null, commits: [], branch: 'b', focus: 'review', canFix: true, canPost: false, role: 'author' });
    const res = await post({ decision: 'request_changes', comment: 'rename the flag to --dry' });
    expect(res.status).toBe(200);
    await app.engine.advance(hil.taskId);
    expect(runner.specs.some((s) => s.prompt.includes('rename the flag to --dry'))).toBe(true);
  });

  it('approve_result approve with a comment and canPost (nothing to fix) is accepted: it is the review text', async () => {
    const { app, hil, post } = await planted({ kind: 'approve_result', diffStat: '', diff: '', testOutput: null, test: null, review: { verdict: 'approve', summary: 'ok', findings: [] }, qa: null, commits: [], branch: 'b', focus: 'review', canFix: false, canPost: true, role: 'reviewer' });
    expect((await post({ decision: 'approve', comment: 'LGTM overall' })).status).toBe(200);
    expect(app.store.getHil(hil.id)!.status).toBe('answered');
  });

  it('refine_prompt approve with a comment and no questions: the note is still appended to the refined prompt', async () => {
    const { app, post, task } = await planted({ kind: 'refine_prompt', prompt: 'x', questions: [], suggestedPrompt: 'Do x', assumptions: [], suggestedTitle: null, suggestedBranch: null });
    // the planted refine is answered first (openHil order is not relied upon: the planted one is targeted by id)
    expect((await post({ decision: 'approve', comment: 'mind the tests' })).status).toBe(200);
    expect(app.store.getTask(task.id)!.refinedPrompt).toBe('Do x\n\n## Additional notes from the human\nmind the tests');
  });
});

describe('approve_plan with a comment on a plan file that already has content', () => {
  it('a plan without a trailing newline gets exactly one blank line before the section; the original text is kept byte for byte', async () => {
    const dir = tmpDir('sdlc-hil-comment-plan-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const runner = new FakeRunner((spec) => ({
      act: () => {
        const p = spec.prompt;
        if (p.includes('Phase: clarify')) return { structured: { questions: [], suggestedPrompt: 'Change a.txt', assumptions: [] } };
        if (p.includes('Phase: plan')) { fs.mkdirSync(path.join(spec.cwd, '.sdlc'), { recursive: true }); fs.writeFileSync(path.join(spec.cwd, '.sdlc/plan.md'), '# Plan\n\n- step'); return { text: 'plan' }; }
        return { text: 'ok' };
      },
    }));
    const app = testApp(dir, runner);
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'standard', baseRemote: null, stopAfter: 'approve_plan' });
    await app.engine.advance(task.id);
    const hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.kind).toBe('approve_plan');
    await app.engine.respondHil(hil.id, { decision: 'approve', comment: 'line one\nline two' }, 'web');
    const run = app.store.latestRunForTask(task.id)!;
    const planPath = app.store.phaseRunsForRun(run.id).find((p) => p.artifacts.plan_md)!.artifacts.plan_md!;
    const plan = fs.readFileSync(planPath, 'utf8');
    expect(plan.startsWith('# Plan\n\n- step\n\n' + HUMAN_ADDITIONS_HEADING + '\n')).toBe(true);
    expect(plan).toContain('line one\nline two\n');
    expect(plan.split(HUMAN_ADDITIONS_HEADING)).toHaveLength(2);
  });
});
