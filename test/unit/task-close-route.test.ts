import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { localHas, makeRemoteRepo, remoteHas, sh, testApp, tmpDir } from '../helpers.js';
import { tasksRoutes } from '../../server/src/http/routes/tasks.js';

/** A branch with one commit pushed to the remote and a pull request for it, as if a colleague opened it. */
function someonesPr(repo: string, gh: FakeGitHub, branch = 'feature'): number {
  sh(repo, ['checkout', '-q', '-b', branch]);
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'one\ntwo\n');
  sh(repo, ['add', '-A']); sh(repo, ['commit', '-q', '-m', `${branch}: work`]);
  sh(repo, ['push', '-q', 'origin', branch]);
  sh(repo, ['checkout', '-q', 'main']); sh(repo, ['branch', '-q', '-D', branch]);
  return gh.openPr(branch, 'main', 'Add the feature', 'Adds feature.txt.');
}

/** A reviewer task sitting at pr_open on somebody else's pull request, and the HTTP app in front of it. */
async function reviewerAtPrOpen(prefix: string) {
  const dir = tmpDir(prefix);
  const { repo, bare } = makeRemoteRepo(dir);
  const gh = new FakeGitHub(bare);
  const n = someonesPr(repo, gh);
  const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: { verdict: 'approve', summary: 'fine', findings: [] } }) })), {}, gh);

  const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
  await app.engine.advance(task.id);
  expect(app.engine.roleOfTask(task.id)).toBe('reviewer');
  const hil = app.store.openHilForTask(task.id)[0]!;
  await app.engine.respondHil(hil.id, { decision: 'approve', reviewEvent: 'approve' }, 'web');
  await app.engine.advance(task.id);
  expect(app.store.getTask(task.id)!.status).toBe('pr_open');

  const hono = new Hono().route('/api', tasksRoutes(app));
  const close = (body: unknown) => hono.request(`/api/tasks/${task.id}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { repo, bare, gh, app, task, n, close };
}

/** `closePr` and `deleteBranch` must not reach somebody else's pull request even when the HTTP body asks for them. */
describe('POST /tasks/:id/close on a reviewer task', () => {
  it('stops tracking without closing the colleague\'s PR', async () => {
    const { bare, gh, app, task, n, close } = await reviewerAtPrOpen('sdlc-close-route-');

    const res = await close({ closePr: true });
    expect(res.status).toBe(200);
    expect(app.store.getTask(task.id)!.status).toBe('closed');
    expect(gh.prs.get(n)!.state).toBe('OPEN');
    expect(gh.calls.filter((c) => c.startsWith('close'))).toEqual([]);
    expect(remoteHas(bare, 'feature')).toBe(true);
  });

  it('ignores deleteBranch too: the colleague\'s branch survives `sdlc close --delete-branch`', async () => {
    const { repo, bare, gh, app, task, n, close } = await reviewerAtPrOpen('sdlc-close-route-branch-');

    const res = await close({ closePr: true, deleteBranch: true });    // what the CLI sends for `close --delete-branch`
    expect(res.status).toBe(200);
    expect((await res.json() as { status: string }).status).toBe('closed');
    expect(app.store.getTask(task.id)!.status).toBe('closed');
    expect(localHas(repo, 'feature')).toBe(true);
    expect(remoteHas(bare, 'feature')).toBe(true);
    expect(gh.prs.get(n)!.state).toBe('OPEN');
  });
});
