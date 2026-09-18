import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { App } from '../../app.js';
import { HttpError } from '../../engine/engine.js';
import { readTranscript } from '../../claude/transcript.js';
import { diffAgainst } from '../../git/git.js';
import { loadPipeline } from '../../pipeline/loader.js';

const CreateTask = z.object({
  prompt: z.string().min(1), repoPath: z.string().min(1), pipeline: z.string().optional(), title: z.string().optional(),
  baseRemote: z.string().nullable().optional(), baseBranch: z.string().optional(),
  reviewMode: z.enum(['conceptual', 'line']).optional(), postReview: z.boolean().optional(),
});

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
  r.get('/tasks/:id', (c) => {
    const t = mustTask(c.req.param('id'));
    return c.json({ task: t, run: store.latestRunForTask(t.id), phaseRuns: store.phaseRunsForTask(t.id), openHil: store.openHilForTask(t.id), worktreeExists: fs.existsSync(path.join(t.worktreePath, '.git')) });
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

function currentPhase(app: App, taskId: string): string | null {
  const run = app.store.latestRunForTask(taskId);
  if (!run) return null;
  const spec = (run.pipelineSnapshot as { spec?: { phases?: { name: string }[] } })?.spec;
  return spec?.phases?.[run.cursor]?.name ?? null;
}
