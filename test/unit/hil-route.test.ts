import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';
import { hilRoutes } from '../../server/src/http/routes/hil.js';

/** The HTTP layer must pass the granular decisions through untouched; a stripped body silently publishes nothing. */
describe('POST /hil/:id/respond', () => {
  it('forwards findings, comments and reviewEvent to the engine', async () => {
    const dir = tmpDir('sdlc-hil-route-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: { questions: [], suggestedPrompt: 'p', assumptions: [] } }) })));
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
});
