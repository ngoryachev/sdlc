import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { makeRepo, sh, testApp, tmpDir } from '../helpers.js';
import { tasksRoutes } from '../../server/src/http/routes/tasks.js';
import { hilRoutes } from '../../server/src/http/routes/hil.js';

/** Stops at the refine checkpoint, which is the HIL request this test reads. */
const runner = () => new FakeRunner((spec) => ({
  act: () => {
    if (spec.prompt.includes('Phase: clarify')) return { structured: { questions: [], suggestedPrompt: 'ABC-123 add a flag', assumptions: [] } };
    return { text: 'ok' };
  },
}));

/**
 * The UI must not assemble these URLs itself (the Jira base is in the config, "is the branch pushed" in the event
 * history): both responses that carry a task hand them over ready.
 */
describe('the task URLs on the HTTP responses', () => {
  const setup = async (o: { jiraUrl?: string } = {}) => {
    const dir = tmpDir('sdlc-task-links-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    sh(repo, ['remote', 'add', 'origin', 'https://github.com/me/shop.git']);   // nothing is pushed; this is only where repoSlug comes from
    const app = testApp(dir, runner(), { repos: [{ name: 'shop', path: repo, gh_user: 'tester', ...(o.jiraUrl ? { jira_url: o.jiraUrl } : {}) }] }, new FakeGitHub(repo));
    const task = await app.engine.createTask({ prompt: 'ABC-123 add a flag', repoPath: repo, pipeline: 'quick', baseRemote: null });
    await app.engine.advance(task.id);
    const hil = app.store.openHilForTask(task.id)[0]!;
    const hono = new Hono().route('/api', tasksRoutes(app)).route('/api', hilRoutes(app));
    const fresh = app.store.getTask(task.id)!;
    return { app, task: fresh, hil, hono };
  };

  const detail = async (hono: Hono, id: string) => await (await hono.request(`/api/tasks/${id}`)).json() as { jiraUrl: string | null; branchUrl: string | null };
  const hilOne = async (hono: Hono, id: string) => (await (await hono.request(`/api/hil/${id}`)).json() as { task: { jiraUrl: string | null; branchUrl: string | null } }).task;

  it('carries both links for a task with a key, a jira_url and a pushed branch', async () => {
    const { app, task, hil, hono } = await setup({ jiraUrl: 'https://x.atlassian.net/' });
    app.events.emit('git.pushed', { taskId: task.id, branch: task.branch }, { taskId: task.id });
    const want = { jiraUrl: 'https://x.atlassian.net/browse/ABC-123', branchUrl: `https://github.com/me/shop/tree/${task.branch}` };
    expect(await detail(hono, task.id)).toMatchObject(want);
    expect(await hilOne(hono, hil.id)).toMatchObject(want);
  });

  it('carries neither for a repository without jira_url and a branch that was never pushed', async () => {
    const { task, hil, hono } = await setup();
    expect(await detail(hono, task.id)).toMatchObject({ jiraUrl: null, branchUrl: null });
    expect(await hilOne(hono, hil.id)).toMatchObject({ jiraUrl: null, branchUrl: null });
  });

  it('keeps the same shape when the task itself is gone', async () => {
    const { app, hil } = await setup({ jiraUrl: 'https://x.atlassian.net' });
    // a store that has lost the task: the fallback reference must still answer with both keys, not leave them out
    const store = Object.assign(Object.create(Object.getPrototypeOf(app.store) as object), app.store, { getTask: () => null }) as typeof app.store;
    const gone = new Hono().route('/api', hilRoutes({ ...app, store }));
    expect((await (await gone.request(`/api/hil/${hil.id}`)).json() as { task: unknown }).task)
      .toEqual({ id: hil.taskId, title: hil.taskId, status: 'unknown', jiraUrl: null, branchUrl: null });
  });
});
