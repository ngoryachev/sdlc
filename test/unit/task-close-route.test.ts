import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { makeRemoteRepo, remoteHas, sh, testApp, tmpDir } from '../helpers.js';
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

/** `closePr` must not reach somebody else's pull request even when the HTTP body asks for it. */
describe('POST /tasks/:id/close on a reviewer task', () => {
  it('stops tracking without closing the colleague\'s PR', async () => {
    const dir = tmpDir('sdlc-close-route-');
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
    const res = await hono.request(`/api/tasks/${task.id}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ closePr: true }) });
    expect(res.status).toBe(200);
    expect(app.store.getTask(task.id)!.status).toBe('closed');
    expect(gh.prs.get(n)!.state).toBe('OPEN');
    expect(gh.calls.filter((c) => c.startsWith('close'))).toEqual([]);
    expect(remoteHas(bare, 'feature')).toBe(true);
  });
});
