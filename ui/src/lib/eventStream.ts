import type { MessageFrame, SdlcEvent } from '@sdlc/shared';
import { useStore } from './store.js';
import { notifyHil } from './notify.js';

type MsgListener = (m: MessageFrame) => void;
const msgListeners = new Set<MsgListener>();
export function onMessageFrame(l: MsgListener): () => void { msgListeners.add(l); return () => msgListeners.delete(l); }

let es: EventSource | null = null;
let started = false;

/** One EventSource for the whole app; reconnects with Last-Event-ID semantics via ?since=. */
export function startEventStream() {
  if (started) return; started = true;
  const connect = () => {
    const since = useStore.getState().lastEventId;
    es = new EventSource(`/api/events?since=${since}`);
    useStore.getState().setConn('connecting');
    es.onopen = () => { useStore.getState().setConn('live'); void useStore.getState().loadAll(); };
    es.onerror = () => {
      useStore.getState().setConn('offline');
      es?.close(); es = null;
      fetch('/api/health').then(() => fetch('/api/config')).then((r) => { if (r.status === 401) useStore.getState().setConn('unauthorized'); }).catch(() => {});
      setTimeout(connect, 2000);
    };
    es.addEventListener('message', (ev) => { const m = JSON.parse((ev as MessageEvent).data) as MessageFrame; for (const l of msgListeners) l(m); });
    const types = ['task.created', 'task.status', 'task.cost', 'phase.started', 'phase.progress', 'phase.finished', 'phase.paused', 'phase.resumed', 'hil.requested', 'hil.answered', 'hil.expired', 'hil.reminder', 'git.committed', 'git.pushed', 'git.pr_created', 'notifier.sent', 'notifier.error', 'engine.warning', 'engine.error'];
    for (const t of types) es.addEventListener(t, (ev) => {
      const e = JSON.parse((ev as MessageEvent).data) as SdlcEvent;
      useStore.getState().applyEvent(e);
      if (e.type === 'hil.requested') notifyHil(e);
    });
  };
  connect();
}
