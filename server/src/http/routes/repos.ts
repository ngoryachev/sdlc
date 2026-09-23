import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { App } from '../../app.js';
import { HttpError } from '../../engine/engine.js';
import { defaultBase, git, listBranches, netEnv, remotes, repoToplevel, slugFromRemote } from '../../git/git.js';
import { ghAvailable } from '../../git/gh.js';

export function reposRoutes(app: App) {
  const r = new Hono();
  const byId = (id: string) => { const repo = app.config.repos.find((x) => x.name === id); if (!repo) throw new HttpError(404, 'repo not found'); return repo; };

  /** Accounts logged in to gh (github.com); `active` is the global gh default, which sdlc does not depend on. */
  r.get('/gh/accounts', async (c) => {
    if (!(await ghAvailable())) return c.json({ accounts: [], error: 'gh CLI is not installed' });
    return c.json({ accounts: await app.github.accounts() });
  });

  /** Registered (cloned) repositories with the account each one is worked on with. */
  r.get('/repos', (c) => c.json({ repos: app.config.repos.map((x) => ({ name: x.name, path: x.path, ghUser: x.gh_user ?? null, exists: fs.existsSync(x.path) })) }));

  /** Every repository the account can see: own, collaborator, organisations; most recently pushed first. */
  r.get('/repos/github', async (c) => {
    if (!(await ghAvailable())) throw new HttpError(400, 'gh CLI is not installed or not authenticated');
    const account = c.req.query('account') || (await app.github.accounts()).find((a) => a.active)?.login || null;
    const auth = await app.accounts.forUser(account);
    const cloned = new Set(await Promise.all(app.config.repos.map(async (x) => (await slugFromRemote(x.path).catch(() => null)) ?? x.name)));
    const repos = (await app.github.listRepos(auth)).map((x) => ({ ...x, cloned: cloned.has(x.slug) }));
    return c.json({ account, repos });
  });

  /** Branches of a repository that is not cloned yet (for the base selector). */
  r.get('/repos/github/branches', async (c) => {
    const slug = c.req.query('slug'); if (!slug) throw new HttpError(400, 'slug required');
    const auth = await app.accounts.forUser(c.req.query('account') || null);
    return c.json({ branches: (await app.github.repoBranches(slug, auth)).map((b) => ({ remote: 'origin', branch: b })) });
  });

  /** Register a repository: clone `slug` with the given account, or add a local path. */
  r.post('/repos', async (c) => {
    const body = z.object({ path: z.string().optional(), slug: z.string().optional(), name: z.string().optional(), gh_user: z.string().optional() }).parse(await c.req.json());
    let p: string;
    if (body.slug) {
      p = path.join(app.config.repos_dir, ...body.slug.split('/'));
      if (!fs.existsSync(p)) await app.github.clone(body.slug, p, await app.accounts.forUser(body.gh_user ?? null));
    } else if (body.path) p = await repoToplevel(path.resolve(body.path));
    else throw new HttpError(400, 'path or slug required');
    const name = body.name ?? body.slug ?? (await slugFromRemote(p)) ?? path.basename(p);
    let entry = app.config.repos.find((x) => path.resolve(x.path) === path.resolve(p));
    if (!entry) { entry = { name, path: p }; app.config.repos.push(entry); }
    if (body.gh_user) entry.gh_user = body.gh_user;
    app.persistConfig();
    const ghUser = await app.accounts.userFor(p);
    return c.json({ name: entry.name, path: p, ghUser }, 201);
  });

  /** Choose the account for a repository; null re-detects it (first logged-in account with push access). */
  r.put('/repos/:id', async (c) => {
    const repo = byId(c.req.param('id'));
    const body = z.object({ gh_user: z.string().nullable() }).parse(await c.req.json());
    if (body.gh_user && !(await app.github.accounts()).some((a) => a.login === body.gh_user)) throw new HttpError(400, `${body.gh_user} is not logged in to gh (gh auth login)`);
    app.accounts.set(repo.path, body.gh_user);
    const ghUser = await app.accounts.userFor(repo.path);
    return c.json({ name: repo.name, path: repo.path, ghUser });
  });

  r.get('/repos/:id/branches', async (c) => {
    const repo = byId(c.req.param('id'));
    const auth = await app.accounts.forRepo(repo.path);
    for (const rm of await remotes(repo.path)) await git(repo.path, ['fetch', '--prune', '--quiet', rm], { allowFail: true, env: netEnv(auth) });
    return c.json({ branches: await listBranches(repo.path), default: await defaultBase(repo.path) });
  });
  r.get('/repos/:id/pr-target', async (c) => { const repo = byId(c.req.param('id')); return c.json(await app.github.repoInfo(repo.path, await app.accounts.forRepo(repo.path))); });
  return r;
}
