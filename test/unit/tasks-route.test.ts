import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Task } from '@sdlc/shared';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';
import { tasksRoutes } from '../../server/src/http/routes/tasks.js';

/** A field missing from the zod schema of the route is silently dropped, so the flag is checked at HTTP level. */
describe('POST /tasks', () => {
  const create = async (prefix: string, body: Record<string, unknown>) => {
    const dir = tmpDir(prefix);
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ text: 'ok' }) })));
    const hono = new Hono().route('/api', tasksRoutes(app));
    const res = await hono.request('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x', repoPath: repo, pipeline: 'standard', baseRemote: null, startAt: 'end', ...body }) });
    return { app, res, task: await res.json() as Task };
  };

  it('stores approveOnClean: false as sent', async () => {
    const { app, res, task } = await create('sdlc-tasks-route-off-', { approveOnClean: false });
    expect(res.status).toBe(201);
    expect(task.approveOnClean).toBe(false);
    expect(app.store.getTask(task.id)!.approveOnClean).toBe(false);
  });

  it('defaults approveOnClean to true when the body omits it', async () => {
    const { app, res, task } = await create('sdlc-tasks-route-default-', {});
    expect(res.status).toBe(201);
    expect(task.approveOnClean).toBe(true);
    expect(app.store.getTask(task.id)!.approveOnClean).toBe(true);
  });
});
