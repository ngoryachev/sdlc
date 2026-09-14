import { Hono } from 'hono';
import { z } from 'zod';
import type { App } from '../../app.js';
import { HttpError } from '../../engine/engine.js';

const Respond = z.object({
  decision: z.enum(['approve', 'request_changes', 'abort', 'allow', 'allow_session', 'deny', 'answer', 'retry', 'resume', 'skip']),
  comment: z.string().optional(),
  edited: z.object({ prompt: z.string().optional(), planMd: z.string().optional(), title: z.string().optional() }).optional(),
  answers: z.record(z.string(), z.string()).optional(),
});

export function hilRoutes(app: App) {
  const r = new Hono();
  r.get('/hil', (c) => c.json({ requests: app.store.listHil({ status: c.req.query('status') ?? 'open', taskId: c.req.query('taskId') || undefined }).map((h) => ({ ...h, task: taskRef(app, h.taskId) })) }));
  r.get('/hil/:id', (c) => { const h = app.store.getHil(c.req.param('id')); if (!h) throw new HttpError(404, 'hil not found'); return c.json({ ...h, task: taskRef(app, h.taskId) }); });
  r.post('/hil/:id/respond', async (c) => {
    const body = Respond.parse(await c.req.json());
    const h = await app.engine.respondHil(c.req.param('id'), body, 'web');
    return c.json(h);
  });
  return r;
}

function taskRef(app: App, id: string) { const t = app.store.getTask(id); return t ? { id: t.id, title: t.title, status: t.status } : { id, title: id, status: 'unknown' }; }
