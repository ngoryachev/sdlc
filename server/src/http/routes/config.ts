import { Hono } from 'hono';
import { z } from 'zod';
import type { App } from '../../app.js';
import { ConfigSchema } from '../../config/config.js';

const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const ConfigPatch = z.object({
  default_pipeline: z.string().optional(),
  max_parallel_tasks: z.number().int().positive().optional(),
  max_loops: z.number().int().min(0).optional(),
  recheck_scope: z.enum(['delta', 'full']).optional(),
  pr_feedback_from: z.enum(['collaborators', 'anyone']).optional(),
  pr_sync_interval: z.union([z.string().regex(/^\d+(m|h)$/), z.literal('off')]).optional(),
  task_budget_usd: z.union([z.number().positive(), z.literal('off')]).optional(),
  limits: z.object({ phases: z.enum(['pipeline', 'off']) }).optional(),
  merge_method: z.enum(['merge', 'squash', 'rebase']).optional(),
  cleanup: z.enum(['on_pr', 'on_approve', 'never']).optional(),
  models: z.object({ default: z.string().optional(), effort: Effort.optional(), phases: z.record(z.string(), z.object({ model: z.string().optional(), effort: Effort.optional() }).strict()) }).optional(),
}).strict();

function view(app: App) {
  const cfg = app.config;
  return {
    publicUrl: cfg.server.public_url ?? `http://${cfg.server.host}:${cfg.server.port}`,
    repos: cfg.repos.map((r) => ({ name: r.name, path: r.path, ghUser: r.gh_user ?? null })), reposDir: cfg.repos_dir, prSyncInterval: cfg.pr_sync_interval, defaultPipeline: cfg.default_pipeline, maxParallelTasks: cfg.max_parallel_tasks, maxLoops: cfg.max_loops, recheckScope: cfg.recheck_scope, prFeedbackFrom: cfg.pr_feedback_from,
    taskBudgetUsd: cfg.task_budget_usd, limits: cfg.limits, mergeMethod: cfg.merge_method, cleanup: cfg.cleanup, models: cfg.models,
    telegram: { enabled: cfg.telegram.enabled, configured: !!cfg.telegram.bot_token, chatId: cfg.telegram.chat_id ?? null },
  };
}

export function configRoutes(app: App) {
  const r = new Hono();
  r.get('/config', (c) => c.json(view(app)));
  /** Partial update; applied in place so running engines pick it up at the next phase, and persisted to ~/.sdlc/config.yaml. */
  r.put('/config', async (c) => {
    const body = ConfigPatch.parse(await c.req.json());
    const merged = ConfigSchema.parse({ ...app.config, ...body, models: body.models ? { ...body.models, phases: dropEmpty(body.models.phases) } : app.config.models });
    Object.assign(app.config, merged);
    app.persistConfig();
    app.engine.applyConfig();
    return c.json(view(app));
  });
  r.post('/config/telegram/test', async (c) => {
    const n = app.notifiers?.find((x) => x.name === 'telegram');
    if (!n?.test) return c.json({ ok: false, error: 'telegram not configured' }, 400);
    try { await n.test(); return c.json({ ok: true }); } catch (e) { return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500); }
  });
  /** Plan usage of the Claude subscription: the last value seen in a phase stream, else asked from the CLI (at most once a minute). */
  let asked = 0;
  r.get('/quota', async (c) => {
    if (!app.quota.latest && app.runner.usage && Date.now() - asked > 60_000) {
      asked = Date.now();
      const q = app.quota.ingestUsage(await app.runner.usage().catch(() => null));
      if (q) app.events.emit('claude.quota', { quota: q });
    }
    return c.json({ quota: app.quota.latest });
  });
  return r;
}

function dropEmpty<T extends Record<string, { model?: string; effort?: string }>>(phases: T): T {
  const out: Record<string, { model?: string; effort?: string }> = {};
  for (const [k, v] of Object.entries(phases)) { const x: { model?: string; effort?: string } = {}; if (v.model) x.model = v.model; if (v.effort) x.effort = v.effort; if (Object.keys(x).length) out[k] = x; }
  return out as T;
}
