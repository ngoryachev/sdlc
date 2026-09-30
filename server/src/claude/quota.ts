import type { ClaudeQuota, QuotaWindow } from '@sdlc/shared';

const iso = (epochSeconds: unknown): string | null => (typeof epochSeconds === 'number' && epochSeconds > 0 ? new Date(epochSeconds * 1000).toISOString() : null);
const pct = (fraction: unknown): number | null => (typeof fraction === 'number' && Number.isFinite(fraction) ? Math.round(fraction * 1000) / 10 : null);

/**
 * Plan usage as the Claude CLI reports it. Two sources: the `rate_limit_event` messages every phase stream carries
 * (fractions 0..1, epoch seconds) and the experimental usage call of the SDK (0..100, ISO), used before any phase ran.
 */
export class QuotaTracker {
  latest: ClaudeQuota | null = null;

  /** Feed any SDK message; returns the new quota when it changed what a user would see. */
  ingest(m: unknown): ClaudeQuota | null {
    const e = m as { type?: string; rate_limit_info?: { status?: string; resetsAt?: number; rateLimitType?: string; utilization?: number; unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | undefined> } };
    if (e?.type !== 'rate_limit_event' || !e.rate_limit_info) return null;
    const info = e.rate_limit_info;
    const win = (key: 'five_hour' | 'seven_day'): QuotaWindow | null => {
      const w = info.unifiedWindows?.[key];
      const u = pct(w?.utilization) ?? (info.rateLimitType === key ? pct(info.utilization) : null);
      if (u === null) return null;
      return { utilization: u, resetsAt: iso(w?.resetsAt ?? (info.rateLimitType === key ? info.resetsAt : undefined)) };
    };
    return this.set({ fiveHour: win('five_hour') ?? this.latest?.fiveHour ?? null, sevenDay: win('seven_day') ?? this.latest?.sevenDay ?? null, status: info.status ?? null });
  }

  /** The `rate_limits` object of the SDK usage call (utilization already 0..100). */
  ingestUsage(r: unknown): ClaudeQuota | null {
    const u = r as { rate_limits?: Record<string, { utilization?: number | null; resets_at?: string | null } | null> | null };
    if (!u?.rate_limits) return null;
    const win = (w: { utilization?: number | null; resets_at?: string | null } | null | undefined): QuotaWindow | null => (w && typeof w.utilization === 'number' ? { utilization: w.utilization, resetsAt: w.resets_at ?? null } : null);
    return this.set({ fiveHour: win(u.rate_limits.five_hour), sevenDay: win(u.rate_limits.seven_day), status: this.latest?.status ?? null });
  }

  private set(q: Omit<ClaudeQuota, 'updatedAt'>): ClaudeQuota | null {
    if (!q.fiveHour && !q.sevenDay) return null;
    const p = this.latest;
    const same = p && p.status === q.status && p.fiveHour?.utilization === q.fiveHour?.utilization && p.fiveHour?.resetsAt === q.fiveHour?.resetsAt && p.sevenDay?.utilization === q.sevenDay?.utilization && p.sevenDay?.resetsAt === q.sevenDay?.resetsAt;
    this.latest = { ...q, updatedAt: new Date().toISOString() };
    return same ? null : this.latest;
  }
}
