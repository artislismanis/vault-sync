import { describe, expect, it } from 'vitest';
import { planSync, PlanInput, RemoteHead } from './planner';
import type { IndexEntry } from './index-store';

const entry = (overrides: Partial<IndexEntry> & { path: string }): IndexEntry => ({
  mtime: 1000,
  size: 10,
  lastSyncedRevisionId: 'rev-a',
  excluded: false,
  basePlaintext: null,
  ...overrides,
});

const head = (overrides: Partial<RemoteHead> & { revisionId: string }): RemoteHead => ({
  deleted: false,
  sizeBytes: 10,
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
        remote: [{ path: 'a.md', heads: [head({ revisionId: 'rev-a' })] }],
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
        remote: [{ path: 'a.md', heads: [head({ revisionId: 'rev-a' })] }],
      }),
    ).toEqual([{ kind: 'push', path: 'a.md', parentIds: ['rev-a'] }]);
  });

  it('pulls remote-only files and remote advances', () => {
    expect(plan({ remote: [{ path: 'a.md', heads: [head({ revisionId: 'rev-b' })] }] })).toEqual([
      { kind: 'pull', path: 'a.md', revisionId: 'rev-b' },
    ]);
    expect(
      plan({
        local: [{ path: 'a.md', mtime: 1000, size: 10 }],
        index: [entry({ path: 'a.md' })],
        remote: [{ path: 'a.md', heads: [head({ revisionId: 'rev-b' })] }],
      }),
    ).toEqual([{ kind: 'pull', path: 'a.md', revisionId: 'rev-b' }]);
  });

  it('propagates a local delete as a tombstone push', () => {
    expect(
      plan({
        index: [entry({ path: 'a.md' })],
        remote: [{ path: 'a.md', heads: [head({ revisionId: 'rev-a' })] }],
      }),
    ).toEqual([{ kind: 'pushDelete', path: 'a.md', parentIds: ['rev-a'] }]);
  });

  it('applies a remote tombstone locally when the file is unchanged', () => {
    expect(
      plan({
        local: [{ path: 'a.md', mtime: 1000, size: 10 }],
        index: [entry({ path: 'a.md' })],
        remote: [{ path: 'a.md', heads: [head({ revisionId: 'rev-b', deleted: true })] }],
      }),
    ).toEqual([{ kind: 'deleteLocal', path: 'a.md', tombstoneId: 'rev-b' }]);
  });

  it('edit wins over delete in both directions', () => {
    expect(
      plan({
        local: [{ path: 'a.md', mtime: 2000, size: 12 }],
        index: [entry({ path: 'a.md' })],
        remote: [{ path: 'a.md', heads: [head({ revisionId: 'rev-b', deleted: true })] }],
      }),
    ).toEqual([{ kind: 'push', path: 'a.md', parentIds: ['rev-b'] }]);
    expect(
      plan({
        index: [entry({ path: 'a.md' })],
        remote: [{ path: 'a.md', heads: [head({ revisionId: 'rev-b' })] }],
      }),
    ).toEqual([{ kind: 'pull', path: 'a.md', revisionId: 'rev-b' }]);
  });

  it('diverged local + remote goes to merge', () => {
    expect(
      plan({
        local: [{ path: 'a.md', mtime: 2000, size: 12 }],
        index: [entry({ path: 'a.md' })],
        remote: [{ path: 'a.md', heads: [head({ revisionId: 'rev-b' })] }],
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
            heads: [head({ revisionId: 'rev-b' }), head({ revisionId: 'rev-c' })],
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
        remote: [{ path: 'a.md', heads: [head({ revisionId: 'rev-b', deleted: true })] }],
      }),
    ).toEqual([{ kind: 'forgetIndex', path: 'a.md' }]);
  });

  describe('size cap', () => {
    const CAP = 100;

    it('excludes oversized local files instead of pushing', () => {
      expect(
        plan({
          local: [{ path: 'video.mp4', mtime: 1, size: 500 }],
          maxFileSizeBytes: CAP,
        }),
      ).toEqual([{ kind: 'exclude', path: 'video.mp4', reason: 'size' }]);
    });

    it('excludes oversized remote-only files instead of pulling', () => {
      expect(
        plan({
          remote: [{ path: 'video.mp4', heads: [head({ revisionId: 'rev-z', sizeBytes: 500 })] }],
          maxFileSizeBytes: CAP,
        }),
      ).toEqual([{ kind: 'exclude', path: 'video.mp4', reason: 'size' }]);
    });

    it('leaves excluded entries alone while still over the cap', () => {
      expect(
        plan({
          local: [{ path: 'video.mp4', mtime: 9, size: 500 }],
          index: [entry({ path: 'video.mp4', excluded: true, lastSyncedRevisionId: null })],
          remote: [{ path: 'video.mp4', heads: [head({ revisionId: 'rev-z', sizeBytes: 500 })] }],
          maxFileSizeBytes: CAP,
        }),
      ).toEqual([]);
    });

    it('re-includes when the cap no longer applies (rejoins via normal path)', () => {
      const excluded = entry({ path: 'video.mp4', excluded: true, lastSyncedRevisionId: null });
      // Cap raised above the file size.
      expect(
        plan({
          local: [{ path: 'video.mp4', mtime: 9, size: 500 }],
          index: [excluded],
          maxFileSizeBytes: 1000,
        }),
      ).toEqual([{ kind: 'forgetIndex', path: 'video.mp4' }]);
      // Cap removed entirely.
      expect(
        plan({
          local: [{ path: 'video.mp4', mtime: 9, size: 500 }],
          index: [excluded],
          maxFileSizeBytes: 0,
        }),
      ).toEqual([{ kind: 'forgetIndex', path: 'video.mp4' }]);
    });

    it('excludes by category, re-includes when the toggle returns', () => {
      const noVideo = (p: string) => p.endsWith('.mp4');
      expect(
        plan({
          local: [{ path: 'clip.mp4', mtime: 1, size: 5 }],
          isCategoryExcluded: noVideo,
        }),
      ).toEqual([{ kind: 'exclude', path: 'clip.mp4', reason: 'category' }]);
      // Remote-only excluded category is never pulled.
      expect(
        plan({
          remote: [{ path: 'clip.mp4', heads: [head({ revisionId: 'rev-v' })] }],
          isCategoryExcluded: noVideo,
        }),
      ).toEqual([{ kind: 'exclude', path: 'clip.mp4', reason: 'category' }]);
      // Toggle re-enabled → rejoins via forgetIndex.
      expect(
        plan({
          local: [{ path: 'clip.mp4', mtime: 1, size: 5 }],
          index: [entry({ path: 'clip.mp4', excluded: true, lastSyncedRevisionId: null })],
          isCategoryExcluded: () => false,
        }),
      ).toEqual([{ kind: 'forgetIndex', path: 'clip.mp4' }]);
      // Notes are unaffected by the filter.
      expect(
        plan({
          local: [{ path: 'a.md', mtime: 1, size: 5 }],
          isCategoryExcluded: noVideo,
        }),
      ).toEqual([{ kind: 'push', path: 'a.md', parentIds: [] }]);
    });

    it('settings-sync toggle-off stop-updates without deleting (config paths)', () => {
      // Master toggle off is expressed via isCategoryExcluded returning true
      // for config paths. Previously-synced config with a remote head must
      // yield `exclude` — never pushDelete — even though the local scan no
      // longer lists it (the config walk is skipped when disabled).
      const configOff = (p: string) => p.startsWith('.obsidian/');
      expect(
        plan({
          local: [], // config walk skipped when the toggle is off
          index: [entry({ path: '.obsidian/app.json' })],
          remote: [{ path: '.obsidian/app.json', heads: [head({ revisionId: 'rev-a' })] }],
          isCategoryExcluded: configOff,
        }),
      ).toEqual([{ kind: 'exclude', path: '.obsidian/app.json', reason: 'category' }]);
      // Remote-only config is never pulled while disabled.
      expect(
        plan({
          remote: [{ path: '.obsidian/hotkeys.json', heads: [head({ revisionId: 'rev-h' })] }],
          isCategoryExcluded: configOff,
        }),
      ).toEqual([{ kind: 'exclude', path: '.obsidian/hotkeys.json', reason: 'category' }]);
      // Re-enabling rejoins through the normal merge/conflict path.
      expect(
        plan({
          local: [{ path: '.obsidian/app.json', mtime: 9, size: 20 }],
          index: [
            entry({ path: '.obsidian/app.json', excluded: true, lastSyncedRevisionId: null }),
          ],
          isCategoryExcluded: () => false,
        }),
      ).toEqual([{ kind: 'forgetIndex', path: '.obsidian/app.json' }]);
    });

    it('mounted-folder scope exclusion stop-updates without deleting', () => {
      // A previously main-synced file that a folder connection now owns:
      // isScopeExcluded (not isCategoryExcluded) marks it excluded — never a
      // delete — even with a remote head and no local scan entry (main's
      // scan no longer covers the mounted subtree).
      const mountOwns = (p: string) => p.startsWith('Reference/');
      expect(
        plan({
          local: [],
          index: [entry({ path: 'Reference/x.md' })],
          remote: [{ path: 'Reference/x.md', heads: [head({ revisionId: 'rev-a' })] }],
          isScopeExcluded: mountOwns,
        }),
      ).toEqual([{ kind: 'exclude', path: 'Reference/x.md', reason: 'scope' }]);
      // Disconnecting the mount (scope filter drops) rejoins normally.
      expect(
        plan({
          local: [{ path: 'Reference/x.md', mtime: 9, size: 20 }],
          index: [entry({ path: 'Reference/x.md', excluded: true, lastSyncedRevisionId: null })],
          isScopeExcluded: () => false,
        }),
      ).toEqual([{ kind: 'forgetIndex', path: 'Reference/x.md' }]);
    });

    it('ignores the cap for tombstone heads and unlimited (0) settings', () => {
      expect(
        plan({
          remote: [
            {
              path: 'gone.mp4',
              heads: [head({ revisionId: 'rev-t', deleted: true, sizeBytes: 500 })],
            },
          ],
          maxFileSizeBytes: CAP,
        }),
      ).toEqual([]);
      expect(
        plan({
          local: [{ path: 'video.mp4', mtime: 1, size: 500 }],
          maxFileSizeBytes: 0,
        }),
      ).toEqual([{ kind: 'push', path: 'video.mp4', parentIds: [] }]);
    });
  });
});
