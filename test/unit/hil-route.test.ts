import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';
import { hilRoutes } from '../../server/src/http/routes/hil.js';
import { HttpError, NO_ANSWER } from '../../server/src/engine/engine.js';

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
