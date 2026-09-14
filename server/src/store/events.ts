import type { DatabaseSync } from 'node:sqlite';
import type { EventPayloads, EventType, MessageFrame, SdlcEvent } from '@sdlc/shared';
import { nowIso } from './ids.js';

export type EventListener = (e: SdlcEvent) => void;
export type MessageListener = (m: MessageFrame) => void;

/** Persists small events to SQLite and fans them out in-process. SDK message frames are fan-out only. */
export class EventBus {
  private listeners = new Set<EventListener>();
  private msgListeners = new Set<MessageListener>();
  constructor(private db: DatabaseSync) {}

  emit<T extends EventType>(type: T, payload: EventPayloads[T], ids: { taskId?: string | null; phaseRunId?: string | null } = {}): SdlcEvent<T> {
    const ts = nowIso();
    const res = this.db.prepare('INSERT INTO events (task_id, phase_run_id, ts, type, payload) VALUES (?,?,?,?,?)')
      .run(ids.taskId ?? null, ids.phaseRunId ?? null, ts, type, JSON.stringify(payload));
    const e: SdlcEvent<T> = { id: Number(res.lastInsertRowid), ts, type, taskId: ids.taskId ?? null, phaseRunId: ids.phaseRunId ?? null, payload };
    for (const l of this.listeners) { try { l(e); } catch (err) { console.error('[events] listener failed', err); } }
    return e;
  }

  message(m: MessageFrame) {
    for (const l of this.msgListeners) { try { l(m); } catch (err) { console.error('[events] message listener failed', err); } }
  }

  on(l: EventListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  onMessage(l: MessageListener): () => void { this.msgListeners.add(l); return () => this.msgListeners.delete(l); }

  replay(since: number, taskId?: string, limit = 1000): SdlcEvent[] {
    const rows = taskId
      ? this.db.prepare('SELECT * FROM events WHERE id > ? AND task_id = ? ORDER BY id LIMIT ?').all(since, taskId, limit)
      : this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?').all(since, limit);
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: r.id as number, ts: r.ts as string, type: r.type as EventType, taskId: (r.task_id as string) ?? null,
      phaseRunId: (r.phase_run_id as string) ?? null, payload: JSON.parse(r.payload as string),
    }));
  }
}
