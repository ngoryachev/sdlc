import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { makeRemoteRepo, makeRepo, sh, testApp, tmpDir } from '../helpers.js';
import type { App } from '../../server/src/app.js';
import { HttpError } from '../../server/src/engine/engine.js';
import { tasksRoutes } from '../../server/src/http/routes/tasks.js';
import { newHilRequest } from '../../server/src/phases/hil.js';

const PASS = { verdict: 'pass', summary: 'ok', commands: [], tests_added: [], failures: [], notes: '' };
const QA_OK = { verdict: 'pass', summary: 'works', checks: [], issues: [] };
const APPROVE = { verdict: 'approve', summary: 'ok', findings: [] };

/** The text is the whole point of this route: a dropped or blank body must not quietly restart a task with no instruction. */
describe('POST /tasks/:id/request-changes', () => {
  // the real app maps HttpError via hono.onError; mirror just that much here
  const mount = (app: App) => {
    const hono = new Hono();
    hono.onError((e, c) => c.json({ error: e.message }, (e instanceof HttpError ? e.status : 500) as 500));
    return hono.route('/api', tasksRoutes(app));
  };
  const post = (hono: Hono, id: string, body: unknown) =>
    hono.request(`/api/tasks/${id}/request-changes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const err = async (r: Response) => (await r.json() as { error: string }).error;

  /** An `auto` task run to the end locally: finished, no pull request, nothing open. */
  const finishedTask = async (prefix: string) => {
    const dir = tmpDir(prefix);
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const runner = new FakeRunner((spec) => ({
      act: () => {
        if (spec.prompt.includes('Phase: test')) return { structured: PASS };
        if (spec.prompt.includes('Phase: review')) return { structured: APPROVE };
        if (spec.prompt.includes('Phase: QA')) return { structured: QA_OK };
        fs.appendFileSync(path.join(spec.cwd, 'a.txt'), 'more\n');
        return { text: 'ok' };
      },
    }));
    const app = testApp(dir, runner);
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'auto', baseRemote: null });
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');
    return { app, runner, task };
  };

  it('rejects a missing or blank text, and hands a real one to the engine', async () => {
    const { app, runner, task } = await finishedTask('sdlc-rc-route-');
    const hono = mount(app);

    expect((await post(hono, task.id, {})).status).toBe(400);
    expect((await post(hono, task.id, { text: '   ' })).status).toBe(400);
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');          // nothing was started

    const res = await post(hono, task.id, { text: 'rename the flag' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ phase: 'implement' });

    await app.engine.advance(task.id);   // the route already kicked the engine; this only waits for it
    expect(runner.specs.filter((s) => s.prompt.includes('rename the flag'))).toHaveLength(1);
    expect(app.store.phaseRunsForTask(task.id).filter((p) => p.phaseName === 'implement')).toHaveLength(2);
    expect((await post(hono, 'nope', { text: 'x' })).status).toBe(404);
  });

  it('refuses a task that is not finished', async () => {
    const { app, task } = await finishedTask('sdlc-rc-route-busy-');
    const t = app.store.getTask(task.id)!;
    t.status = 'running'; app.store.updateTask(t);
    const res = await post(mount(app), task.id, { text: 'now' });
    expect(res.status).toBe(409);
    expect(await err(res)).toMatch(/task is running/);
  });

  it('refuses a task that only reviews a pull request', async () => {
    const dir = tmpDir('sdlc-rc-route-reviewer-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    sh(repo, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'one\n');
    sh(repo, ['add', '-A']); sh(repo, ['commit', '-q', '-m', 'feature']); sh(repo, ['push', '-q', 'origin', 'feature']);
    sh(repo, ['checkout', '-q', 'main']); sh(repo, ['branch', '-q', '-D', 'feature']);
    const n = gh.openPr('feature', 'main', 'Add the feature', 'body');
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: APPROVE }) })), {}, gh);

    const reviewer = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(reviewer.id);
    await app.engine.respondHil(app.store.openHilForTask(reviewer.id)[0]!.id, { decision: 'approve', reviewEvent: 'approve' }, 'web');
    await app.engine.advance(reviewer.id);
    expect(app.store.getTask(reviewer.id)!.status).toBe('pr_open');

    const res = await post(mount(app), reviewer.id, { text: 'fix it yourself' });
    expect(res.status).toBe(409);
    expect(await err(res)).toMatch(/only reviews/);
  });
  it('refuses a task with a question already waiting, and one that is already merged', async () => {
    const { app, task } = await finishedTask('sdlc-rc-route-guards-');
    const hono = mount(app);

    // an open request first: a second instruction on top of it would be answered by nobody
    const hil = newHilRequest({ taskId: task.id, phaseRunId: null, kind: 'question', title: 'q', summary: 'q', payload: { kind: 'question', questions: [] } });
    app.store.insertHil(hil);
    let res = await post(hono, task.id, { text: 'now' });
    expect(res.status).toBe(409);
    expect(await err(res)).toMatch(/already open/);
    hil.status = 'answered'; app.store.updateHil(hil);

    // merged (or closed): the task is delivered for good, there is nothing to send back
    const t = app.store.getTask(task.id)!; t.status = 'merged'; app.store.updateTask(t);
    res = await post(hono, task.id, { text: 'now' });
    expect(res.status).toBe(409);
    expect(await err(res)).toMatch(/task is merged/);
    expect(app.store.getTask(task.id)!.status).toBe('merged');
  });
});
