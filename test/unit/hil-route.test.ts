import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';
import { hilRoutes } from '../../server/src/http/routes/hil.js';
import { HttpError } from '../../server/src/engine/engine.js';

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
