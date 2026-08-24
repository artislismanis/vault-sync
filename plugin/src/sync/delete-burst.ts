// Trailing-window rate gate for deletes, orthogonal to planner.ts's per-pass
// applySafetyBrake(). Records only deletes that actually executed — recording
// a blocked batch would deadlock, since blocked actions never advance the
// index and get re-proposed identically every pass (docs/decisions.md).

export interface DeleteBurstOptions {
  windowMs: number;
  maxDeletes: number;
}

export const DEFAULT_DELETE_BURST_OPTIONS: DeleteBurstOptions = {
  windowMs: 10 * 60 * 1000,
  maxDeletes: 50,
};

export class DeleteBurstTracker {
  private entries: { at: number; count: number }[] = [];

  constructor(private opts: DeleteBurstOptions = DEFAULT_DELETE_BURST_OPTIONS) {}

  private prune(now: number): void {
    const cutoff = now - this.opts.windowMs;
    this.entries = this.entries.filter((e) => e.at >= cutoff);
  }

  /** True when executed deletes in the trailing window are already at/over the cap. */
  isTripped(now: number): boolean {
    return this.windowCount(now) >= this.opts.maxDeletes;
  }

  /** Record deletes that actually ran. */
  record(count: number, now: number): void {
    if (count <= 0) return;
    this.prune(now);
    this.entries.push({ at: now, count });
  }

  /** Executed-delete count within the trailing window, for notice/tooltip text. */
  windowCount(now: number): number {
    this.prune(now);
    return this.entries.reduce((sum, e) => sum + e.count, 0);
  }
}
