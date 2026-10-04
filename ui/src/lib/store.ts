import { create } from 'zustand';
import type { ClaudeQuota, HilRequest, SdlcEvent, Task } from '@sdlc/shared';
import type { HilRow, TaskRow } from './api.js';
import { api } from './api.js';

export type Conn = 'connecting' | 'live' | 'offline' | 'unauthorized';

interface State {
  conn: Conn;
  tasks: TaskRow[];
  hil: HilRow[];
  lastEventId: number;
  rawEvents: SdlcEvent[];
  quota: ClaudeQuota | null;
  toasts: { id: number; text: string; kind: 'info' | 'error' }[];
  setConn(c: Conn): void;
  loadAll(): Promise<void>;
  applyEvent(e: SdlcEvent): void;
  toast(text: string, kind?: 'info' | 'error'): void;
  dismissToast(id: number): void;
}

let toastId = 0;
export const useStore = create<State>((set, get) => ({
  conn: 'connecting', tasks: [], hil: [], lastEventId: 0, rawEvents: [], quota: null, toasts: [],
  setConn: (conn) => set({ conn }),
  loadAll: async () => {
    const [t, h, q] = await Promise.all([api.tasks(), api.hil('open'), api.quota().catch(() => ({ quota: null }))]);
    set({ tasks: t.tasks, hil: h.requests, quota: q.quota ?? get().quota });
  },
  applyEvent: (e) => {
    const s = get();
    const raw = [...s.rawEvents, e].slice(-500);
    let tasks = s.tasks; let hil = s.hil; let quota = s.quota;
    const upsertTask = (task: Task, patch: Partial<TaskRow> = {}) => {
      const i = tasks.findIndex((x) => x.id === task.id);
      const row: TaskRow = { ...(i >= 0 ? tasks[i]! : { openHil: 0, currentPhase: null }), ...task, ...patch } as TaskRow;
      tasks = i >= 0 ? tasks.map((x, j) => (j === i ? row : x)) : [row, ...tasks];
    };
    switch (e.type) {
      case 'task.created': upsertTask((e.payload as { task: Task }).task); break;
      case 'task.status': upsertTask((e.payload as { task: Task }).task); break;
      case 'task.updated': upsertTask((e.payload as { task: Task }).task); break;
      case 'task.branch': { const p = e.payload as { taskId: string; to: string }; tasks = tasks.map((t) => (t.id === p.taskId ? { ...t, branch: p.to } : t)); break; }
      case 'task.cost': { const p = e.payload as { taskId: string; totalCostUsd: number }; tasks = tasks.map((t) => (t.id === p.taskId ? { ...t, totalCostUsd: p.totalCostUsd } : t)); break; }
      case 'phase.started': { const p = e.payload as { phaseRun: { taskId: string; phaseName: string } }; tasks = tasks.map((t) => (t.id === p.phaseRun.taskId ? { ...t, currentPhase: p.phaseRun.phaseName } : t)); break; }
      case 'hil.requested': { const h = (e.payload as { hil: HilRequest }).hil; const task = tasks.find((t) => t.id === h.taskId); hil = [{ ...h, task: { id: h.taskId, title: task?.title ?? h.title, status: task?.status ?? '' } }, ...hil.filter((x) => x.id !== h.id)]; tasks = tasks.map((t) => (t.id === h.taskId ? { ...t, openHil: t.openHil + 1 } : t)); break; }
      case 'hil.answered': case 'hil.expired': { const h = (e.payload as { hil: HilRequest }).hil; const had = hil.some((x) => x.id === h.id); hil = hil.filter((x) => x.id !== h.id); if (had) tasks = tasks.map((t) => (t.id === h.taskId ? { ...t, openHil: Math.max(0, t.openHil - 1) } : t)); break; }
      case 'claude.quota': quota = (e.payload as { quota: ClaudeQuota }).quota; break;
      default: break;
    }
    set({ rawEvents: raw, tasks, hil, quota, lastEventId: Math.max(s.lastEventId, e.id) });
  },
  // errors stay long enough to be read; a click dismisses any toast
  toast: (text, kind = 'info') => { const id = ++toastId; set((s) => ({ toasts: [...s.toasts, { id, text, kind }] })); setTimeout(() => get().dismissToast(id), kind === 'error' ? 20000 : 5000); },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
