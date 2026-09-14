import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { App } from '../../app.js';
import { HttpError } from '../../engine/engine.js';
import { saveConfig } from '../../config/config.js';
import { defaultBase, git, listBranches, repoToplevel } from '../../git/git.js';
import { cloneRepo, ghAvailable, listRepos, repoSlug } from '../../git/gh.js';

export function reposRoutes(app: App) {
  const r = new Hono();
  const byId = (id: string) => { const repo = app.config.repos.find((x) => x.name === id); if (!repo) throw new HttpError(404, 'repo not found'); return repo; };

  r.get('/repos', (c) => c.json({ repos: app.config.repos.map((x) => ({ ...x, exists: fs.existsSync(x.path) })), ghAvailable: undefined }));
  r.get('/repos/github', async (c) => {
    if (!(await ghAvailable())) throw new HttpError(400, 'gh CLI is not installed or not authenticated');
    return c.json({ repos: await listRepos(c.req.query('q') || undefined) });
  });
  r.post('/repos', async (c) => {
    const body = z.object({ path: z.string().optional(), slug: z.string().optional(), name: z.string().optional() }).parse(await c.req.json());
    let p: string;
    if (body.slug) {
      p = path.join(app.config.repos_dir, ...body.slug.split('/'));
      if (!fs.existsSync(p)) await cloneRepo(body.slug, p);
    } else if (body.path) p = await repoToplevel(path.resolve(body.path));
    else throw new HttpError(400, 'path or slug required');
    const name = body.name ?? body.slug ?? path.basename(p);
    if (!app.config.repos.some((x) => x.path === p)) { app.config.repos.push({ name, path: p }); saveConfig(app.config); }
    return c.json({ name, path: p }, 201);
  });
  r.get('/repos/:id/branches', async (c) => {
    const repo = byId(c.req.param('id'));
    await git(repo.path, ['fetch', '--all', '--prune'], { allowFail: true });
    return c.json({ branches: await listBranches(repo.path), default: await defaultBase(repo.path) });
  });
  r.get('/repos/:id/pr-target', async (c) => { const repo = byId(c.req.param('id')); return c.json(await repoSlug(repo.path)); });
  return r;
}
