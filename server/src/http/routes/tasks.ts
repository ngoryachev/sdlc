import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { App } from '../../app.js';
import { HttpError } from '../../engine/engine.js';
import { readTranscript } from '../../claude/transcript.js';
import { diffAgainst } from '../../git/git.js';
import { loadPipeline } from '../../pipeline/loader.js';

const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const ModelOverrides = z.record(z.string(), z.object({ model: z.string().optional(), effort: Effort.optional() }).strict()).nullable().optional();
const CreateTask = z.object({
  prompt: z.string().min(1), repoPath: z.string().min(1), pipeline: z.string().optional(), title: z.string().optional(),
  baseRemote: z.string().nullable().optional(), baseBranch: z.string().optional(),
  reviewMode: z.enum(['conceptual', 'line']).optional(), postReview: z.boolean().optional(),
  branch: z.string().optional(), startAt: z.string().optional(), modelOverrides: ModelOverrides,
});
const ImportPr = z.object({ repoPath: z.string().min(1), number: z.number().int().positive(), pipeline: z.string().optional(), reviewMode: z.enum(['conceptual', 'line']).optional(), modelOverrides: ModelOverrides });

export function tasksRoutes(app: App) {
  const r = new Hono();
  const { store, engine } = app;
  const mustTask = (id: string) => { const t = store.getTask(id); if (!t) throw new HttpError(404, 'task not found'); return t; };

  r.get('/tasks', (c) => {
    const status = c.req.query('status');
    const tasks = store.listTasks(status ? status.split(',') : undefined).map((t) => ({ ...t, openHil: store.openHilForTask(t.id).length, currentPhase: currentPhase(app, t.id) }));
    return c.json({ tasks });
  });
  r.post('/tasks', async (c) => {
    const body = CreateTask.parse(await c.req.json());
    const task = await engine.createTask(body);
    return c.json(task, 201);
  });
  r.post('/tasks/import-pr', async (c) => {
    const body = ImportPr.parse(await c.req.json());
    return c.json(await engine.importPr(body), 201);
  });
  r.get('/models', async (c) => {
    try { return c.json({ models: app.runner.models ? await app.runner.models() : [] }); }
    catch (e) { return c.json({ models: [], error: e instanceof Error ? e.message : String(e) }); }
  });
  r.post('/tasks/sync', async (c) => c.json(await engine.syncTasks()));
  r.get('/tasks/:id', (c) => {
    const t = mustTask(c.req.param('id'));
    const children = engine.childTasks(t, true).map((x) => ({ id: x.id, title: x.title, status: x.status, branch: x.branch, prUrl: x.prUrl, prNumber: x.prNumber }));
    return c.json({ task: t, run: store.latestRunForTask(t.id), phaseRuns: store.phaseRunsForTask(t.id), openHil: store.openHilForTask(t.id), worktreeExists: fs.existsSync(path.join(t.worktreePath, '.git')), baseChain: baseChain(app, t), children });
  });
  r.post('/tasks/:id/pr', async (c) => {
    const b = z.object({ title: z.string().optional(), draft: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    mustTask(c.req.param('id'));
    return c.json(await engine.createPrForTask(c.req.param('id'), b));
  });
  r.post('/tasks/:id/close', async (c) => {
    const b = z.object({ deleteBranch: z.boolean().optional(), closePr: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    mustTask(c.req.param('id'));
    return c.json(await engine.closeTask(c.req.param('id'), b));
  });
  r.post('/tasks/:id/land', async (c) => {
    const b = z.object({ method: z.enum(['merge', 'squash', 'rebase']).optional() }).parse(await c.req.json().catch(() => ({})));
    mustTask(c.req.param('id'));
    return c.json(await engine.landTask(c.req.param('id'), b.method));
  });
  r.put('/tasks/:id/models', async (c) => {
    const b = z.object({ modelOverrides: ModelOverrides }).parse(await c.req.json());
    return c.json(engine.setModelOverrides(c.req.param('id'), b.modelOverrides ?? null));
  });
  r.post('/tasks/:id/pause', async (c) => { await engine.pause(c.req.param('id')); return c.json(mustTask(c.req.param('id'))); });
  r.post('/tasks/:id/resume', async (c) => { const b = await c.req.json().catch(() => ({})) as { guidance?: string }; await engine.resume(c.req.param('id'), b.guidance); return c.json(mustTask(c.req.param('id'))); });
  r.post('/tasks/:id/abort', async (c) => { await engine.abort(c.req.param('id')); return c.json(mustTask(c.req.param('id'))); });
  r.post('/tasks/:id/inject', async (c) => { const b = z.object({ text: z.string().min(1) }).parse(await c.req.json()); mustTask(c.req.param('id')); return c.json({ accepted: true, ...engine.inject(c.req.param('id'), b.text) }); });
  r.post('/tasks/:id/worktree/remove', async (c) => { mustTask(c.req.param('id')); return c.json(await engine.removeTaskWorktree(c.req.param('id'))); });
  r.post('/tasks/:id/pr/poll', async (c) => { mustTask(c.req.param('id')); return c.json(await engine.pollPrFeedback(c.req.param('id'))); });

  r.get('/tasks/:id/diff', async (c) => {
    const t = mustTask(c.req.param('id'));
    if (!fs.existsSync(t.worktreePath)) return c.json({ stat: '', patch: '', commits: [], truncated: false, missing: true });
    const baseRef = t.baseRemote ? `${t.baseRemote}/${t.baseBranch}` : t.baseBranch;
    return c.json(await diffAgainst(t.worktreePath, baseRef));
  });
  r.get('/tasks/:id/artifacts', (c) => {
    const t = mustTask(c.req.param('id'));
    const dir = path.join(t.worktreePath, '.sdlc');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size })) : [];
    return c.json({ artifacts: files });
  });
  r.get('/tasks/:id/artifacts/:name', (c) => {
    const t = mustTask(c.req.param('id'));
    const name = path.basename(c.req.param('name'));
    const p = path.join(t.worktreePath, '.sdlc', name);
    if (!fs.existsSync(p)) throw new HttpError(404, 'artifact not found');
    return c.text(fs.readFileSync(p, 'utf8'));
  });
  r.get('/phase-runs/:id/transcript', async (c) => {
    const pr = store.getPhaseRun(c.req.param('id'));
    if (!pr) throw new HttpError(404, 'phase run not found');
    if (!pr.transcriptPath) return c.json({ lines: [], next: 0, eof: true });
    const from = Number(c.req.query('from') ?? 0); const limit = Number(c.req.query('limit') ?? 500);
    return c.json(await readTranscript(pr.transcriptPath, from, limit));
  });
  r.get('/pipelines', (c) => {
    const out: { name: string; description?: string; phases: { name: string; type: string; hil?: string }[] }[] = [];
    for (const d of app.config.pipelines_dirs) {
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d).filter((x) => /\.ya?ml$/.test(x))) {
        try {
          const lp = loadPipeline(path.join(d, f));
          out.push({ name: lp.spec.name, description: lp.spec.description, phases: lp.spec.phases.map((p) => ({ name: p.name, type: p.type, hil: p.type === 'hil' ? p.hil : undefined })) });
        } catch (e) { out.push({ name: f, description: `invalid: ${e instanceof Error ? e.message : String(e)}`, phases: [] }); }
      }
    }
    return c.json({ pipelines: out });
  });
  r.get('/stats', (c) => {
    const rows = store.db.prepare(`SELECT substr(created_at,1,10) day, COUNT(*) tasks, SUM(total_cost_usd) cost FROM tasks GROUP BY day ORDER BY day DESC LIMIT 30`).all();
    return c.json({ days: rows });
  });
  return r;
}

/** The base branch and, when that branch belongs to another sdlc task, that task, recursively (newest task per branch wins). */
function baseChain(app: App, t: { baseBranch: string; baseRemote: string | null; repoPath: string }): { branch: string; taskId?: string; title?: string; status?: string }[] {
  const out: { branch: string; taskId?: string; title?: string; status?: string }[] = [];
  const all = app.store.listTasks().filter((x) => x.repoPath === t.repoPath);
  let cur = t.baseBranch;
  for (let i = 0; i < 10; i++) {
    const owner = all.find((x) => x.branch === cur);
    out.push(owner ? { branch: cur, taskId: owner.id, title: owner.title, status: owner.status } : { branch: cur });
    if (!owner) break;
    cur = owner.baseBranch;
  }
  return out;
}

function currentPhase(app: App, taskId: string): string | null {
  const run = app.store.latestRunForTask(taskId);
  if (!run) return null;
  const spec = (run.pipelineSnapshot as { spec?: { phases?: { name: string }[] } })?.spec;
  return spec?.phases?.[run.cursor]?.name ?? null;
}
