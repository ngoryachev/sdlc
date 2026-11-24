import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';
import { hilRoutes } from '../../server/src/http/routes/hil.js';
import { HttpError, NO_ANSWER } from '../../server/src/engine/engine.js';
import { newHilRequest } from '../../server/src/phases/hil.js';
import { commentDelivery, type HilPayload } from '@sdlc/shared';

/** The status mapping createHttpApp installs: without it every refusal reads as a 500. */
const withErrors = (hono: Hono) => hono.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message, ...err.extra }, err.status as 400) : c.json({ error: err.message }, 500)));

/** The HTTP layer must pass the granular decisions through untouched; a stripped body silently publishes nothing. */
describe('POST /hil/:id/respond', () => {
  it('forwards findings, comments and reviewEvent to the engine', async () => {
    const dir = tmpDir('sdlc-hil-route-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    // a clarifying question: without one the refine checkpoint answers itself and never reaches the route
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: { questions: [{ question: 'Which file?', header: 'File' }], suggestedPrompt: 'p', assumptions: [] } }) })));
    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'standard', baseRemote: null });
    await app.engine.advance(task.id);
    const hil = app.store.openHilForTask(task.id)[0]!;   // refine_prompt: any response shape is stored as sent
    const hono = new Hono().route('/api', hilRoutes(app));
    const res = await hono.request(`/api/hil/${hil.id}/respond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'abort', findings: { 'review:0': 'post' }, comments: { 'c1': 'skip' }, reviewEvent: 'approve' }) });
    expect(res.status).toBe(200);
    const saved = app.store.getHil(hil.id)!.response!;
    expect(saved.findings).toEqual({ 'review:0': 'post' });
    expect(saved.comments).toEqual({ c1: 'skip' });
    expect(saved.reviewEvent).toBe('approve');
  });

  it('refuses an answer to a checkpoint the pipeline already answered itself', async () => {
    const dir = tmpDir('sdlc-hil-route-auto-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    // clarify asks nothing: the refine checkpoint answers itself, so nothing is left for the route to apply
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: { title: 'T', questions: [], suggestedPrompt: 'p', assumptions: [] } }) })));
    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'standard', baseRemote: null, stopAfter: 'refine' });
    await app.engine.advance(task.id);
    const hil = app.store.listHil({ taskId: task.id })[0]!;
    expect(hil.answeredVia).toBe('auto');

    const hono = withErrors(new Hono().route('/api', hilRoutes(app)));
    const res = await hono.request(`/api/hil/${hil.id}/respond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'abort' }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'already answered', answeredVia: 'auto' });
    expect(app.store.getHil(hil.id)!.response!.decision).toBe('approve');   // the auto answer stands
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');
  });
});

/**
 * The web UI answers only through this route, so the engine's dropped "answer the clarifying question(s) first"
 * has to be gone here too: a body without `answers` must be a plain 200, not a 400 the UI shows as a toast.
 */
describe('POST /hil/:id/respond: a refine checkpoint with an unanswered question', () => {
  const runner = () => new FakeRunner((spec) => ({
    act: () => {
      const p = spec.prompt;
      if (p.includes('Phase: clarify')) return { structured: { questions: [{ question: 'Which file?', header: 'File' }], suggestedPrompt: 'Change a.txt', assumptions: [] } };
      if (p.includes('Phase: implement')) { fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'y\n'); return { text: 'implemented' }; }
      if (p.includes('Phase: self_check')) return { text: 'checked' };
      if (p.includes('Phase: test')) return { structured: { verdict: 'skipped', summary: 'n/a', commands: [], tests_added: [], failures: [], notes: '' } };
      if (p.includes('Phase: review')) return { structured: { verdict: 'approve', summary: 'ok', findings: [] } };
      if (p.includes('Phase: QA')) return { structured: { verdict: 'skipped', summary: 'n/a', checks: [], issues: [] } };
      throw new Error('unexpected prompt: ' + p.slice(0, 80));
    },
  }));

  it('is approved with no answers field at all', async () => {
    const dir = tmpDir('sdlc-hil-route-open-q-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const app = testApp(dir, runner());
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'quick', baseRemote: null });
    await app.engine.advance(task.id);
    const hil = app.store.openHilForTask(task.id)[0]!;
    const hono = new Hono().route('/api', hilRoutes(app));
    const res = await hono.request(`/api/hil/${hil.id}/respond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) });
    expect(res.status).toBe(200);
    await app.engine.advance(task.id);
    expect(app.store.getHil(hil.id)!.status).toBe('answered');
    expect(app.store.getTask(task.id)!.refinedPrompt).toBe(`Change a.txt\n\n## Clarifying questions\n- **File**: Which file?\n  → ${NO_ANSWER}`);
  });

  it('is approved with an empty string for that question, which is the same thing', async () => {
    const dir = tmpDir('sdlc-hil-route-blank-q-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const app = testApp(dir, runner());
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'quick', baseRemote: null });
    await app.engine.advance(task.id);
    const hil = app.store.openHilForTask(task.id)[0]!;
    const hono = new Hono().route('/api', hilRoutes(app));
    const res = await hono.request(`/api/hil/${hil.id}/respond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve', answers: { 'Which file?': '' } }) });
    expect(res.status).toBe(200);
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.refinedPrompt).toContain(NO_ANSWER);
  });
});

/**
 * A comment nothing would read is refused with a 400 and the checkpoint stays open: before, it was accepted and dropped,
 * and the human believed it had been passed on.
 */
describe('POST /hil/:id/respond: a comment the decision would drop', () => {
  const payloads: Record<string, HilPayload> = {
    escalation: { kind: 'escalation', phaseName: 'implement', error: 'boom', resultSubtype: null },
    pr_feedback: { kind: 'pr_feedback', prUrl: 'https://github.com/o/r/pull/1', comments: [{ id: 'c1', author: 'bob', body: 'nit', url: 'u' }] },
    approve_result: { kind: 'approve_result', diffStat: '', diff: '', testOutput: null, test: null, review: { verdict: 'approve', summary: 'ok', findings: [] }, qa: null, commits: [], branch: 'b', focus: 'review', canFix: true, canPost: false, role: 'author' },
    approve_plan: { kind: 'approve_plan', planMd: '# P\n', summary: 's', costUsd: 0 },
  };
  const setup = async (kind: keyof typeof payloads) => {
    const dir = tmpDir('sdlc-hil-route-drop-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const runner = new FakeRunner(() => ({ act: () => ({ structured: { questions: [{ question: 'Which file?', header: 'File' }], suggestedPrompt: 'p', assumptions: [] } }) }));
    const app = testApp(dir, runner);
    // quick has no plan phase: no plan_md artifact for an approval comment to land in
    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'quick', baseRemote: null });
    await app.engine.advance(task.id);
    const hil = newHilRequest({ taskId: task.id, phaseRunId: null, kind: payloads[kind]!.kind, title: 't', summary: 's', payload: payloads[kind]! });
    app.store.insertHil(hil);
    const hono = withErrors(new Hono().route('/api', hilRoutes(app)));
    const post = (body: unknown) => hono.request(`/api/hil/${hil.id}/respond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { app, hil, post, runner };
  };

  it.each([
    ['escalation', 'retry', /escalation: a comment is not delivered with retry; use resume/],
    ['escalation', 'skip', /escalation: a comment is not delivered with skip/],
    ['pr_feedback', 'skip', /pr_feedback: a comment is not delivered with skip/],
    ['approve_result', 'approve', /approve_result: a comment is not delivered with approve; mark items fix or request changes/],
    ['approve_plan', 'approve', /no plan artifact to carry the comment/],
  ] as const)('%s %s with a comment → 400, the checkpoint stays open', async (kind, decision, msg) => {
    const { app, hil, post } = await setup(kind);
    const res = await post({ decision, comment: 'please note' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(msg);
    expect(app.store.getHil(hil.id)!.status).toBe('open');
  });

  it('the same decision without a comment goes through (pr_feedback skip)', async () => {
    const { app, hil, post } = await setup('pr_feedback');
    expect((await post({ decision: 'skip', comment: '  ' })).status).toBe(200);
    expect(app.store.getHil(hil.id)!.status).toBe('answered');
  });

  it('pr_feedback approve with every comment skipped still sends the guidance to the implementer', async () => {
    const { app, hil, post, runner } = await setup('pr_feedback');
    expect((await post({ decision: 'approve', comments: { c1: 'skip' }, comment: 'squash the helpers' })).status).toBe(200);
    await app.engine.advance(hil.taskId);
    expect(runner.specs.some((s) => s.prompt.includes('left guidance') && s.prompt.includes('squash the helpers'))).toBe(true);
  });

  it('abort with a comment is never refused', async () => {
    const { app, hil, post } = await setup('escalation');
    expect((await post({ decision: 'abort', comment: 'giving up' })).status).toBe(200);
    expect(app.store.getHil(hil.id)!.status).toBe('answered');
  });

  it('a fix-marked result checkpoint takes a comment with approve: it goes back with the items', async () => {
    const p = { ...payloads.approve_result!, review: { verdict: 'request_changes', summary: 's', findings: [{ severity: 'should_fix', title: 'T', description: 'd' }] } } as HilPayload;
    expect(commentDelivery(p, 'approve', true)).toBe('agent');
  });
});

describe('commentDelivery', () => {
  const result = (canFix: boolean, canPost: boolean): HilPayload => ({ kind: 'approve_result', diffStat: '', diff: '', testOutput: null, test: null, review: null, qa: null, commits: [], branch: 'b', focus: 'review', canFix, canPost, role: 'author' });
  it('tells where a comment ends up for each kind and decision', () => {
    const plan: HilPayload = { kind: 'approve_plan', planMd: '', summary: '', costUsd: 0 };
    const refine: HilPayload = { kind: 'refine_prompt', prompt: '', questions: [], suggestedPrompt: null, assumptions: [], suggestedTitle: null, suggestedBranch: null };
    const fb: HilPayload = { kind: 'pr_feedback', prUrl: '', comments: [] };
    const q: HilPayload = { kind: 'question', questions: [] };
    const esc: HilPayload = { kind: 'escalation', phaseName: 'x', error: '', resultSubtype: null };
    expect([commentDelivery(plan, 'approve', false), commentDelivery(plan, 'request_changes', false)]).toEqual(['agent', 'agent']);
    expect(commentDelivery(refine, 'approve', false)).toBe('agent');
    expect([commentDelivery(result(true, false), 'approve', false), commentDelivery(result(true, false), 'approve', true), commentDelivery(result(true, false), 'request_changes', false)]).toEqual(['none', 'agent', 'agent']);
    expect([commentDelivery(result(false, true), 'approve', false), commentDelivery(result(false, false), 'approve', false)]).toEqual(['pr', 'none']);
    expect([commentDelivery(fb, 'approve', false), commentDelivery(fb, 'skip', false)]).toEqual(['agent', 'none']);
    expect(commentDelivery(q, 'answer', false)).toBe('agent');
    expect([commentDelivery(esc, 'resume', false), commentDelivery(esc, 'retry', false), commentDelivery(esc, 'skip', false)]).toEqual(['agent', 'none', 'none']);
    expect(commentDelivery(esc, 'abort', false)).toBe('none');   // never refused: the server lets abort through regardless
  });
});
