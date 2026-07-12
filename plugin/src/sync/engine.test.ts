import { describe, expect, it } from 'vitest';
import type { VaultKeys } from '@vault-sync/shared';
import type { RestClient } from '../transport/rest';
import { SyncEngine, contentIdentical } from './engine';
import { IndexStore } from './index-store';
import { ChunkSpool, SpoolFs } from './spool';
import type { SyncScope } from './scope';

// Root-missing guard (hard rule 4): a mounted folder connection whose local
// root vanished (deleted/renamed in the file explorer) must never let the
// planner see "everything gone" and emit mass deletes. This is the one
// engine-level behavior worth a direct test — everything else is exercised
// through planner.test.ts (pure) and scope.test.ts (I/O mapping).

function stubScope(overrides: Partial<SyncScope> = {}): SyncScope {
  return {
    scan: async () => [],
    stat: async () => null,
    read: async () => null,
    write: async () => ({ mtime: 0, size: 0 }),
    remove: async () => {},
    exists: async () => false,
    isPolicyExcluded: () => false,
    isRootPresent: async () => true,
    toLocalPath: (p) => p,
    ...overrides,
  };
}

function stubSpool(): ChunkSpool {
  const fs: SpoolFs = {
    exists: async () => false,
    mkdir: async () => {},
    writeBinary: async () => {},
    readBinary: async () => new ArrayBuffer(0),
    rmdir: async () => {},
    list: async () => ({ files: [], folders: [] }),
  };
  return new ChunkSpool(fs, 'spool');
}

function stubIndex(): IndexStore {
  return new IndexStore(
    {
      exists: async () => false,
      read: async () => '[]',
      write: async () => {},
    } as never,
    'index.json',
  );
}

describe('engine root-missing guard', () => {
  it('skips the pass, notifies once, and never calls heads()', async () => {
    let headsCalls = 0;
    const rest = { heads: async () => (headsCalls++, { items: [] }) } as unknown as RestClient;
    const notices: string[] = [];
    const scope = stubScope({ isRootPresent: async () => false });

    const engine = new SyncEngine({
      scope,
      rest,
      keys: {} as VaultKeys,
      vaultId: 'v1',
      deviceName: 'test',
      index: stubIndex(),
      getMaxFileSizeBytes: () => 0,
      getParallelTransfers: () => 1,
      isCategoryExcluded: () => false,
      spool: stubSpool(),
      log: () => {},
      notify: (m) => notices.push(m),
      status: () => {},
    });

    const first = await engine.requestSync();
    expect(first).toBe(0);
    expect(headsCalls).toBe(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/connection folder is missing/);

    // Second run while still missing: no repeat notice.
    await engine.requestSync();
    expect(notices).toHaveLength(1);
  });

  it('resumes silently once the root reappears', async () => {
    let rootPresent = false;
    let headsCalls = 0;
    const rest = { heads: async () => (headsCalls++, { items: [] }) } as unknown as RestClient;
    const notices: string[] = [];
    const scope = stubScope({ isRootPresent: async () => rootPresent });

    const engine = new SyncEngine({
      scope,
      rest,
      keys: {} as VaultKeys,
      vaultId: 'v1',
      deviceName: 'test',
      index: stubIndex(),
      getMaxFileSizeBytes: () => 0,
      getParallelTransfers: () => 1,
      isCategoryExcluded: () => false,
      spool: stubSpool(),
      log: () => {},
      notify: (m) => notices.push(m),
      status: () => {},
    });

    await engine.requestSync();
    expect(notices).toHaveLength(1);

    rootPresent = true;
    await engine.requestSync();
    expect(headsCalls).toBe(1); // proceeded past the guard
    expect(notices).toHaveLength(1); // no new notice on recovery
  });
});

// The reconnect no-op: disconnecting a folder connection drops its sync index,
// so on reconnect merge() sees base == null and would fall to conflictFile()
// for an unchanged file. contentIdentical is the guard that adopts the remote
// revision instead of spawning a spurious "(conflict ...)" sibling.
describe('contentIdentical', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it('treats byte-identical content as identical', () => {
    expect(contentIdentical('notes/a.md', enc('# hello\n'), enc('# hello\n'))).toBe(true);
  });

  it('folds CRLF vs LF for mergeable text', () => {
    expect(contentIdentical('notes/a.md', enc('a\r\nb\r\n'), enc('a\nb\n'))).toBe(true);
  });

  it('folds Unicode normalization for mergeable text', () => {
    const nfc = 'caf\u00e9'; // é as one codepoint (NFC)
    const nfd = 'cafe\u0301'; // e + combining acute accent (NFD)
    expect(contentIdentical('notes/a.md', enc(nfc), enc(nfd))).toBe(true);
  });

  it('reports genuinely diverged text as different', () => {
    expect(contentIdentical('notes/a.md', enc('a\nb\n'), enc('a\nc\n'))).toBe(false);
  });

  it('does not normalize non-mergeable (binary) paths — only exact bytes count', () => {
    expect(contentIdentical('img/x.png', enc('a\r\nb'), enc('a\nb'))).toBe(false);
    expect(contentIdentical('img/x.png', enc('abc'), enc('abc'))).toBe(true);
  });
});
