import type { SdlcEvent } from '@sdlc/shared';
import { loadConfig } from '../config/config.js';

/** HTTP client for a running `sdlc serve`; null when no server answers. */
export class ServerClient {
  constructor(public base: string, private token: string) {}

  static async detect(): Promise<ServerClient | null> {
    const cfg = loadConfig();
    const base = process.env.SDLC_SERVER ?? `http://${cfg.server.host === '0.0.0.0' ? '127.0.0.1' : cfg.server.host}:${cfg.server.port}`;
    if (!cfg.server.token) return null;
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return null;
      return new ServerClient(base, cfg.server.token);
    } catch { return null; }
  }

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.base}/api${path}`, { method, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j as { error?: string }).error ?? `${r.status} ${r.statusText}`);
    return j as T;
  }

  /** Stream events (and optionally SDK messages) for a task until `until` returns true. */
  async tail(taskId: string, onEvent: (e: SdlcEvent) => void, onMessage: (m: { sdk: unknown }) => void, until: (e: SdlcEvent) => boolean, since = 0): Promise<void> {
    const r = await fetch(`${this.base}/api/events?taskId=${encodeURIComponent(taskId)}&since=${since}`, { headers: { authorization: `Bearer ${this.token}` } });
    if (!r.ok || !r.body) throw new Error(`SSE failed: ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let event = 'message'; const data: string[] = [];
        for (const line of frame.split('\n')) { if (line.startsWith('event:')) event = line.slice(6).trim(); else if (line.startsWith('data:')) data.push(line.slice(5).trim()); }
        if (!data.length || event === 'ping' || event === 'hello') continue;
        const payload = JSON.parse(data.join('\n'));
        if (event === 'message') onMessage(payload);
        else { onEvent(payload); if (until(payload)) { await reader.cancel(); return; } }
      }
    }
  }
}

export const TERMINAL = new Set(['waiting_hil', 'paused', 'succeeded', 'failed', 'aborted', 'pr_open']);
export const untilTaskSettles = (e: SdlcEvent) => e.type === 'task.status' && TERMINAL.has((e.payload as { to: string }).to);
