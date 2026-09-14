import type { HilResponse } from '@sdlc/shared';

type Resolver = { resolve: (r: HilResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null };

/** In-memory bridge between an open HIL request and a canUseTool promise waiting inside a running phase. */
export class HilBroker {
  private pending = new Map<string, Resolver>();

  wait(hilId: string, timeoutMs: number | null, onTimeout: () => void): Promise<HilResponse> {
    return new Promise<HilResponse>((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => { this.pending.delete(hilId); onTimeout(); reject(new Error('hil timeout')); }, timeoutMs) : null;
      this.pending.set(hilId, { resolve, reject, timer });
    });
  }
  /** Returns true when a live waiter consumed the response. */
  resolve(hilId: string, r: HilResponse): boolean {
    const p = this.pending.get(hilId);
    if (!p) return false;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(hilId);
    p.resolve(r);
    return true;
  }
  cancel(hilId: string, reason: string) {
    const p = this.pending.get(hilId);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(hilId);
    p.reject(new Error(reason));
  }
  has(hilId: string) { return this.pending.has(hilId); }
}
