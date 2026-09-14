import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { EventBus } from '../store/events.js';

export function sseHandler(events: EventBus) {
  return (c: Context) => {
    const since = Number(c.req.header('Last-Event-ID') ?? c.req.query('since') ?? 0) || 0;
    const taskId = c.req.query('taskId') || undefined;
    const withMessages = c.req.query('messages') !== '0';
    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => { closed = true; });
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ since }), retry: 2000 });
      for (const e of events.replay(since, taskId)) await stream.writeSSE({ id: String(e.id), event: e.type, data: JSON.stringify(e) });
      const queue: Array<{ id?: string; event: string; data: string }> = [];
      let wake: (() => void) | null = null;
      const push = (f: { id?: string; event: string; data: string }) => { queue.push(f); wake?.(); };
      const off1 = events.on((e) => { if (!taskId || e.taskId === taskId) push({ id: String(e.id), event: e.type, data: JSON.stringify(e) }); });
      const off2 = withMessages ? events.onMessage((m) => { if (!taskId || m.taskId === taskId) push({ event: 'message', data: JSON.stringify(m) }); }) : () => {};
      try {
        while (!closed) {
          if (!queue.length) {
            await Promise.race([new Promise<void>((r) => { wake = r; }), new Promise<void>((r) => setTimeout(r, 15_000))]);
            wake = null;
            if (!queue.length && !closed) { await stream.writeSSE({ event: 'ping', data: '' }); continue; }
          }
          while (queue.length && !closed) await stream.writeSSE(queue.shift()!);
        }
      } finally { off1(); off2(); }
    });
  };
}
