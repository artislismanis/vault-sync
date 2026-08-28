import { describe, expect, it } from 'vitest';
import { DeleteBurstTracker } from './delete-burst';

const opts = { windowMs: 60_000, maxDeletes: 10 };

describe('DeleteBurstTracker', () => {
  it('is untripped when empty', () => {
    const t = new DeleteBurstTracker(opts);
    expect(t.isTripped(0)).toBe(false);
    expect(t.windowCount(0)).toBe(0);
  });

  it('is untripped below the cap', () => {
    const t = new DeleteBurstTracker(opts);
    t.record(9, 0);
    expect(t.isTripped(0)).toBe(false);
    expect(t.windowCount(0)).toBe(9);
  });

  it('is tripped at the cap (inclusive boundary)', () => {
    const t = new DeleteBurstTracker(opts);
    t.record(10, 0);
    expect(t.isTripped(0)).toBe(true);
  });

  it('is tripped over the cap', () => {
    const t = new DeleteBurstTracker(opts);
    t.record(11, 0);
    expect(t.isTripped(0)).toBe(true);
  });

  it('accumulates across multiple record calls', () => {
    const t = new DeleteBurstTracker(opts);
    t.record(4, 0);
    t.record(4, 1_000);
    expect(t.isTripped(1_000)).toBe(false);
    t.record(2, 2_000);
    expect(t.isTripped(2_000)).toBe(true);
  });

  it('prunes entries older than the window and untrips', () => {
    const t = new DeleteBurstTracker(opts);
    t.record(10, 0);
    expect(t.isTripped(0)).toBe(true);
    // Exactly at the window edge: this entry is still counted (>= cutoff).
    expect(t.isTripped(60_000)).toBe(true);
    // Past the window: the entry ages out.
    expect(t.isTripped(60_001)).toBe(false);
    expect(t.windowCount(60_001)).toBe(0);
  });

  it('record(0) is a no-op', () => {
    const t = new DeleteBurstTracker(opts);
    t.record(0, 0);
    expect(t.windowCount(0)).toBe(0);
  });

  it('does not deadlock: never records deletes that were withheld elsewhere', () => {
    // This test documents the invariant this module depends on: the CALLER
    // must only call record() for deletes that actually executed. A blocked
    // batch that got "recorded" would re-trip forever, since blocked actions
    // are re-proposed identically every pass (never advancing the index).
    const t = new DeleteBurstTracker({ windowMs: 60_000, maxDeletes: 5 });
    t.record(6, 0); // one real burst
    expect(t.isTripped(0)).toBe(true);
    // No further record() calls simulate every subsequent pass being blocked
    // (nothing new committed) — the window must still empty out on its own.
    expect(t.isTripped(60_001)).toBe(false);
  });
});
