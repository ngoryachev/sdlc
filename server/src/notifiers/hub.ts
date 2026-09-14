import type { HilRequest, Task } from '@sdlc/shared';
import type { App } from '../app.js';
import type { Notifier } from './types.js';

/** Subscribes once to the event bus and fans out to notifiers; failures are isolated and logged as events. */
export function startNotifierHub(app: App, notifiers: Notifier[], publicUrl: string): () => void {
  const { events, store } = app;
  const link = (p: string) => `${publicUrl.replace(/\/$/, '')}${p}`;
  const safe = async (n: Notifier, fn: () => Promise<void> | undefined, hilId?: string) => {
    try { await fn(); events.emit('notifier.sent', { channel: n.name, hilId }); }
    catch (e) { events.emit('notifier.error', { channel: n.name, message: e instanceof Error ? e.message : String(e) }); }
  };
  const off = events.on((e) => {
    switch (e.type) {
      case 'hil.requested': { const hil = (e.payload as { hil: HilRequest }).hil; const task = store.getTask(hil.taskId); if (!task) return; for (const n of notifiers) void safe(n, () => n.onHilCreated(hil, task, link(`/hil/${hil.id}`)), hil.id); break; }
      case 'hil.answered': { const hil = (e.payload as { hil: HilRequest }).hil; const task = store.getTask(hil.taskId); if (!task) return; for (const n of notifiers) if (n.onHilAnswered) void safe(n, () => n.onHilAnswered!(hil, task), hil.id); break; }
      case 'task.status': { const p = e.payload as { task: Task; from: string; to: string }; if (!['succeeded', 'failed', 'aborted', 'pr_open', 'paused'].includes(p.to)) return; for (const n of notifiers) if (n.onTaskStatus) void safe(n, () => n.onTaskStatus!(p.task, p.from, p.to, link(`/tasks/${p.task.id}`))); break; }
      case 'engine.error': { const p = e.payload as { taskId?: string; message: string }; for (const n of notifiers) if (n.onError) void safe(n, () => n.onError!(p.taskId, p.message)); break; }
      default: break;
    }
  });
  for (const n of notifiers) void n.start?.().catch((err) => events.emit('notifier.error', { channel: n.name, message: `start failed: ${err instanceof Error ? err.message : String(err)}` }));
  return () => { off(); for (const n of notifiers) void n.stop?.(); };
}

export class ConsoleNotifier implements Notifier {
  readonly name = 'console';
  async onHilCreated(req: HilRequest, task: Task, link: string) { console.log(`[HIL] ${req.kind} · ${task.title} · ${req.summary}\n      ${link}`); }
  async onTaskStatus(task: Task, _from: string, to: string, link: string) { console.log(`[task] ${task.title} → ${to}  ${link}`); }
}
