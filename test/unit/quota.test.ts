import { describe, it, expect } from 'vitest';
import { QuotaTracker } from '../../server/src/claude/quota.js';

describe('QuotaTracker', () => {
  it('reads both windows from a rate_limit_event and reports only real changes', () => {
    const q = new QuotaTracker();
    const event = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1790781000, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.05, resetsAt: 1790781000 }, seven_day: { utilization: 0.1, resetsAt: 1791068400 } } } };
    expect(q.ingest({ type: 'assistant' })).toBeNull();
    const first = q.ingest(event)!;
    expect(first.fiveHour).toEqual({ utilization: 5, resetsAt: new Date(1790781000 * 1000).toISOString() });
    expect(first.sevenDay).toEqual({ utilization: 10, resetsAt: new Date(1791068400 * 1000).toISOString() });
    expect(first.status).toBe('allowed');
    expect(q.ingest(event)).toBeNull();                                  // same numbers: nothing to tell the UI
    const moved = q.ingest({ ...event, rate_limit_info: { ...event.rate_limit_info, unifiedWindows: { five_hour: { utilization: 0.061, resetsAt: 1790781000 } } } })!;
    expect(moved.fiveHour!.utilization).toBe(6.1);
    expect(moved.sevenDay!.utilization).toBe(10);                        // a window missing from one event keeps its last value
  });

  it('falls back to the single window of an event without unifiedWindows, and reads the SDK usage call', () => {
    const q = new QuotaTracker();
    expect(q.ingest({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.8, resetsAt: 1791068400 } })!.sevenDay!.utilization).toBe(80);
    const u = q.ingestUsage({ rate_limits: { five_hour: { utilization: 42, resets_at: '2026-10-01T10:00:00Z' }, seven_day: null } })!;
    expect(u.fiveHour).toEqual({ utilization: 42, resetsAt: '2026-10-01T10:00:00Z' });
    expect(new QuotaTracker().ingestUsage({ rate_limits: null })).toBeNull();
  });
});
