import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { App } from '../../app.js';
import { HttpError } from '../../engine/engine.js';
import { MAX_REPO_FILE_BYTES, envNameError, removeRepoFile, repoFileList, repoFilePath, saveRepoFile } from '../../config/repo-files.js';
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

  /** Every repository the account can see: own, collaborator, organisations; most recently pushed first. `?fresh=1` skips the server cache. */
  r.get('/repos/github', async (c) => {
    if (!(await ghAvailable())) throw new HttpError(400, 'gh CLI is not installed or not authenticated');
    const account = c.req.query('account') || (await app.github.accounts()).find((a) => a.active)?.login || null;
    const auth = await app.accounts.forUser(account);
    const cloned = new Set(await Promise.all(app.config.repos.map(async (x) => (await slugFromRemote(x.path).catch(() => null)) ?? x.name)));
    const fresh = ['1', 'true'].includes(c.req.query('fresh') ?? '');
    const repos = (await app.github.listRepos(auth, { fresh })).map((x) => ({ ...x, cloned: cloned.has(x.slug) }));
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
    if (!entry) { entry = { name, path: p, files: [] }; app.config.repos.push(entry); }
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

  // ---------------------------------------------------------------- per-repository files (phase env variables)
  // Metadata only, here and everywhere else: the contents of these files (keystores, service-account JSON, .env
  // secrets) are given to phases as a path on disk and never travel back over HTTP.
  r.get('/repos/:id/files', (c) => c.json({ files: repoFileList(byId(c.req.param('id')).files) }));

  /** Upload or replace the file bound to an env variable name. multipart: `env` + `file`. */
  r.post('/repos/:id/files', async (c) => {
    const repo = byId(c.req.param('id'));
    // guard against parsing a huge body into memory at all; the cap itself is checked on the file's own bytes below,
    // since what is declared here is the file plus the multipart envelope
    if (Number(c.req.header('content-length') ?? 0) > MAX_REPO_FILE_BYTES + 64 * 1024) throw new HttpError(413, `file is too large (limit ${MAX_REPO_FILE_BYTES} bytes)`);
    const body = await c.req.parseBody();
    const env = typeof body.env === 'string' ? body.env.trim() : '';
    if (!env) throw new HttpError(400, 'env (the environment variable name) is required');
    const bad = envNameError(env);
    if (bad) throw new HttpError(400, bad);
    const file = body.file;
    if (!(file instanceof File)) throw new HttpError(400, 'file is required');
    const data = Buffer.from(await file.arrayBuffer());
    if (data.byteLength > MAX_REPO_FILE_BYTES) throw new HttpError(413, `file is too large (limit ${MAX_REPO_FILE_BYTES} bytes)`);
    const prev = repo.files.find((f) => f.env === env);
    const abs = repoFilePath(app.config, repo.name, env, file.name, repo.files.filter((f) => f.env !== env).map((f) => f.path));
    saveRepoFile(abs, data);
    // a replacement under a different filename leaves the old copy behind otherwise
    if (prev && path.resolve(prev.path) !== path.resolve(abs)) removeRepoFile(app.config, repo.name, prev.path);
    if (prev) prev.path = abs; else repo.files.push({ env, path: abs });
    app.persistConfig();
    return c.json({ files: repoFileList(repo.files) }, 201);
  });

  /** Forget the variable and delete the stored file. */
  r.delete('/repos/:id/files/:env', (c) => {
    const repo = byId(c.req.param('id'));
    const env = c.req.param('env');
    const i = repo.files.findIndex((f) => f.env === env);
    if (i < 0) throw new HttpError(404, `no file configured for ${env}`);
    const [removed] = repo.files.splice(i, 1);
    removeRepoFile(app.config, repo.name, removed!.path);
    app.persistConfig();
    return c.json({ files: repoFileList(repo.files) });
  });
  return r;
}
