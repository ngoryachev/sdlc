import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { makeRemoteRepo, testApp, tmpDir } from '../helpers.js';
import { reposRoutes } from '../../server/src/http/routes/repos.js';
import { ghAvailable, type GhRepo, type RepoAuth } from '../../server/src/git/gh.js';

/** Records how the route asks for the list, so the cache-bypass flag can be checked. */
class CountingGitHub extends FakeGitHub {
  listCalls: { user: string | null; fresh: boolean }[] = [];
  override async listRepos(auth: RepoAuth, o: { fresh?: boolean } = {}): Promise<GhRepo[]> {
    this.listCalls.push({ user: auth.user, fresh: !!o.fresh });
    return [{ slug: 'tester/new', description: '', isFork: false, isPrivate: false, pushedAt: null, defaultBranch: 'main', canPush: true }];
  }
}

// the route probes the real `gh` binary before listing
describe.skipIf(!(await ghAvailable()))('GET /repos/github', () => {
  it('passes ?fresh=1 through so a repository created a moment ago bypasses the server cache', async () => {
    const dir = tmpDir('sdlc-repos-route-');
    const { bare } = makeRemoteRepo(dir);
    const gh = new CountingGitHub(bare);
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ text: 'ok' }) })), {}, gh);
    const hono = new Hono().route('/api', reposRoutes(app));

    const plain = await hono.request('/api/repos/github?account=tester');
    expect(plain.status).toBe(200);
    expect((await plain.json() as { repos: { slug: string; cloned: boolean }[] }).repos).toEqual([{ slug: 'tester/new', cloned: false, description: '', isFork: false, isPrivate: false, pushedAt: null, defaultBranch: 'main', canPush: true }]);
    const fresh = await hono.request('/api/repos/github?account=tester&fresh=1');
    expect(fresh.status).toBe(200);
    expect(gh.listCalls).toEqual([{ user: 'tester', fresh: false }, { user: 'tester', fresh: true }]);
  });
});
