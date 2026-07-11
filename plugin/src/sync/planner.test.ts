import { describe, expect, it } from 'vitest';
import { planSync, PlanInput } from './planner';
import type { IndexEntry } from './index-store';

const entry = (overrides: Partial<IndexEntry> & { path: string }): IndexEntry => ({
  mtime: 1000,
  size: 10,
  lastSyncedRevisionId: 'rev-a',
  excluded: false,
  basePlaintext: null,
  ...overrides,
});

const plan = (input: Partial<PlanInput>) =>
  planSync({ local: [], index: [], remote: [], ...input });

describe('planSync', () => {
  it('is a no-op when all three views agree', () => {
    expect(
      plan({
        local: [{ path: 'a.md', mtime: 1000, size: 10 }],
        index: [entry({ path: 'a.md' })],
        remote: [{ path: 'a.md', heads: [{ revisionId: 'rev-a', deleted: false }] }],
      }),
    ).toEqual([]);
  });

  it('pushes brand-new local files with no parents', () => {
    expect(plan({ local: [{ path: 'new.md', mtime: 1, size: 5 }] })).toEqual([
      { kind: 'push', path: 'new.md', parentIds: [] },
    ]);
  });

  it('pushes local edits citing the current head', () => {
    expect(
      plan({
        local: [{ path: 'a.md', mtime: 2000, size: 12 }],
        index: [entry({ path: 'a.md' })],
        remote: [{ path: 'a.md', heads: [{ revisionId: 'rev-a', deleted: false }] }],
      }),
    ).toEqual([{ kind: 'push', path: 'a.md', parentIds: ['rev-a'] }]);
  });

  it('pulls remote-only files and remote advances', () => {
    expect(
      plan({ remote: [{ path: 'a.md', heads: [{ revisionId: 'rev-b', deleted: false }] }] }),
    ).toEqual([{ kind: 'pull', path: 'a.md', revisionId: 'rev-b' }]);
    expect(
      plan({
        local: [{ path: 'a.md', mtime: 1000, size: 10 }],
        index: [entry({ path: 'a.md' })],
        remote: [{ path: 'a.md', heads: [{ revisionId: 'rev-b', deleted: false }] }],
      }),
    ).toEqual([{ kind: 'pull', path: 'a.md', revisionId: 'rev-b' }]);
  });

  it('propagates a local delete as a tombstone push', () => {
    expect(
      plan({
        index: [entry({ path: 'a.md' })],
        remote: [{ path: 'a.md', heads: [{ revisionId: 'rev-a', deleted: false }] }],
      }),
    ).toEqual([{ kind: 'pushDelete', path: 'a.md', parentIds: ['rev-a'] }]);
  });

  it('applies a remote tombstone locally when the file is unchanged', () => {
    expect(
      plan({
        local: [{ path: 'a.md', mtime: 1000, size: 10 }],
        index: [entry({ path: 'a.md' })],
        remote: [{ path: 'a.md', heads: [{ revisionId: 'rev-b', deleted: true }] }],
      }),
    ).toEqual([{ kind: 'deleteLocal', path: 'a.md', tombstoneId: 'rev-b' }]);
  });

  it('edit wins over delete in both directions', () => {
    // Local edit vs remote delete → push resurrects.
    expect(
      plan({
        local: [{ path: 'a.md', mtime: 2000, size: 12 }],
        index: [entry({ path: 'a.md' })],
        remote: [{ path: 'a.md', heads: [{ revisionId: 'rev-b', deleted: true }] }],
      }),
    ).toEqual([{ kind: 'push', path: 'a.md', parentIds: ['rev-b'] }]);
    // Local delete vs remote edit → pull restores.
    expect(
      plan({
        index: [entry({ path: 'a.md' })],
        remote: [{ path: 'a.md', heads: [{ revisionId: 'rev-b', deleted: false }] }],
      }),
    ).toEqual([{ kind: 'pull', path: 'a.md', revisionId: 'rev-b' }]);
  });

  it('diverged local + remote goes to merge', () => {
    expect(
      plan({
        local: [{ path: 'a.md', mtime: 2000, size: 12 }],
        index: [entry({ path: 'a.md' })],
        remote: [{ path: 'a.md', heads: [{ revisionId: 'rev-b', deleted: false }] }],
      }),
    ).toEqual([{ kind: 'merge', path: 'a.md', remoteRevisionId: 'rev-b' }]);
  });

  it('multiple remote heads go to mergeHeads before anything else', () => {
    expect(
      plan({
        local: [{ path: 'a.md', mtime: 2000, size: 12 }],
        index: [entry({ path: 'a.md' })],
        remote: [
          {
            path: 'a.md',
            heads: [
              { revisionId: 'rev-b', deleted: false },
              { revisionId: 'rev-c', deleted: false },
            ],
          },
        ],
      }),
    ).toEqual([{ kind: 'mergeHeads', path: 'a.md', headIds: ['rev-b', 'rev-c'] }]);
  });

  it('cleans up index entries when both sides are gone', () => {
    expect(plan({ index: [entry({ path: 'a.md' })] })).toEqual([
      { kind: 'forgetIndex', path: 'a.md' },
    ]);
    expect(
      plan({
        index: [entry({ path: 'a.md', lastSyncedRevisionId: 'rev-b' })],
        remote: [{ path: 'a.md', heads: [{ revisionId: 'rev-b', deleted: true }] }],
      }),
    ).toEqual([{ kind: 'forgetIndex', path: 'a.md' }]);
  });

  it('never touches excluded entries', () => {
    expect(
      plan({
        local: [{ path: 'big.pdf', mtime: 9999, size: 999 }],
        index: [entry({ path: 'big.pdf', excluded: true })],
        remote: [{ path: 'big.pdf', heads: [{ revisionId: 'rev-z', deleted: false }] }],
      }),
    ).toEqual([]);
  });
});
