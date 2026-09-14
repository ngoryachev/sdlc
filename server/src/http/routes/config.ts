import { Hono } from 'hono';
import type { App } from '../../app.js';

export function configRoutes(app: App) {
  const r = new Hono();
  r.get('/config', (c) => {
    const cfg = app.config;
    return c.json({
      publicUrl: cfg.server.public_url ?? `http://${cfg.server.host}:${cfg.server.port}`,
      repos: cfg.repos, reposDir: cfg.repos_dir, defaultPipeline: cfg.default_pipeline, maxParallelTasks: cfg.max_parallel_tasks,
      taskBudgetUsd: cfg.task_budget_usd, cleanup: cfg.cleanup,
      telegram: { enabled: cfg.telegram.enabled, configured: !!cfg.telegram.bot_token, chatId: cfg.telegram.chat_id ?? null },
    });
  });
  r.post('/config/telegram/test', async (c) => {
    const n = app.notifiers?.find((x) => x.name === 'telegram');
    if (!n?.test) return c.json({ ok: false, error: 'telegram not configured' }, 400);
    try { await n.test(); return c.json({ ok: true }); } catch (e) { return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500); }
  });
  return r;
}
