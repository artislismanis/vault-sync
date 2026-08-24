import { beforeAll, describe, expect, it } from 'vitest';
import {
  initSodium,
  deriveVaultKeys,
  encryptPath,
  pathHmac,
  createStreamEncryptor,
  chunkCountFor,
  CHUNK_BYTES,
  type VaultKeys,
  type Revision,
} from '@vault-sync/shared';
import type { RestClient } from '../transport/rest';
import { SyncEngine, contentIdentical } from './engine';
import { IndexStore } from './index-store';
import { ChunkSpool, SpoolFs } from './spool';
import type { FileStat, SyncScope } from './scope';

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

// D1 regression: an edit landing while pull()/merge() awaits a slow download
// must never be silently overwritten (hard rule 4). These call the engine's
// private methods directly — the only way to observe one guarded operation
// in isolation, since fullSync() always runs the full multi-pass loop.
describe('content-state guard (D1)', () => {
  let keys: VaultKeys;
  const enc = (s: string) => new TextEncoder().encode(s);
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);

  beforeAll(async () => {
    await initSodium();
    keys = deriveVaultKeys(crypto.getRandomValues(new Uint8Array(32)));
  });

  function fakeFs() {
    const files = new Map<string, { bytes: Uint8Array; mtime: number; size: number }>();
    const scope: SyncScope = {
      scan: async () => [...files].map(([path, f]) => ({ path, mtime: f.mtime, size: f.size })),
      stat: async (path) => {
        const f = files.get(path);
        return f ? { mtime: f.mtime, size: f.size } : null;
      },
      read: async (path) => files.get(path)?.bytes ?? null,
      write: async (path, bytes) => {
        const stat: FileStat = { mtime: Date.now(), size: bytes.byteLength };
        files.set(path, { bytes, ...stat });
        return stat;
      },
      remove: async (path) => {
        files.delete(path);
      },
      exists: async (path) => files.has(path),
      isPolicyExcluded: () => false,
      isRootPresent: async () => true,
      toLocalPath: (p) => p,
    };
    return { files, scope };
  }

  function buildRemoteRevision(id: string, plaintext: Uint8Array) {
    const encryptor = createStreamEncryptor(keys.contentKey, id);
    const chunks = chunkCountFor(plaintext.byteLength);
    const ciphertexts: Uint8Array[] = [];
    for (let seq = 0; seq < chunks; seq++) {
      const slice = plaintext.subarray(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES);
      ciphertexts.push(encryptor.pushChunk(slice, seq === chunks - 1));
    }
    const revision = {
      id,
      itemId: 'item-1',
      parentIds: [],
      sizeBytes: plaintext.byteLength,
      deviceId: 'device-1',
      clientMtime: new Date().toISOString(),
      serverReceivedAt: new Date().toISOString(),
      deleted: false,
      chunks,
      streamHeaderB64: encryptor.headerB64,
    } as unknown as Revision;
    return { revision, ciphertexts };
  }

  function stubRest(path: string, revision: Revision, ciphertexts: Uint8Array[]): RestClient {
    return {
      heads: async () => ({
        items: [
          {
            itemId: revision.itemId,
            pathHmac: pathHmac(keys.macKey, path),
            encryptedPathB64: encryptPath(keys, path),
            heads: [revision],
          },
        ],
      }),
      getChunk: async (_vaultId: string, _revisionId: string, seq: number) => ciphertexts[seq]!,
    } as unknown as RestClient;
  }

  function buildEngine(scope: SyncScope, rest: RestClient, index: IndexStore) {
    return new SyncEngine({
      scope,
      rest,
      keys,
      vaultId: 'v1',
      deviceName: 'test',
      index,
      getMaxFileSizeBytes: () => 0,
      getParallelTransfers: () => 1,
      isCategoryExcluded: () => false,
      spool: stubSpool(),
      log: () => {},
      notify: () => {},
      status: () => {},
    });
  }

  it('pull() does not overwrite an edit that lands during the download', async () => {
    const { files, scope } = fakeFs();
    const path = 'notes/a.md';
    files.set(path, { bytes: enc('original'), mtime: 1000, size: 8 });

    const { revision, ciphertexts } = buildRemoteRevision('rev-new', enc('remote content'));
    const rest = stubRest(path, revision, ciphertexts);
    // Simulate a concurrent edit landing while the (single-chunk) download
    // is "in flight" — mutate the file right before getChunk returns.
    const realGetChunk = rest.getChunk.bind(rest);
    rest.getChunk = async (...args) => {
      const result = await realGetChunk(...args);
      files.set(path, { bytes: enc('edited during download'), mtime: 5000, size: 23 });
      return result;
    };

    const index = new IndexStore(
      { exists: async () => false, read: async () => '[]', write: async () => {} } as never,
      'index.json',
    );
    await index.load();
    index.set({
      path,
      mtime: 1000,
      size: 8,
      lastSyncedRevisionId: 'rev-old',
      excluded: false,
      basePlaintext: null,
      contentHash: null,
    });

    const engine = buildEngine(scope, rest, index) as unknown as {
      fetchRemote: () => Promise<void>;
      pull: (path: string, revisionId: string) => Promise<void>;
    };
    await engine.fetchRemote();
    await engine.pull(path, 'rev-new');

    // The edit must survive — neither discarded nor silently marked synced.
    expect(dec(files.get(path)!.bytes)).toBe('edited during download');
    expect(index.get(path)?.lastSyncedRevisionId).toBe('rev-old');
  });

  it('merge() does not overwrite an edit that lands during the download', async () => {
    const { files, scope } = fakeFs();
    const path = 'notes/a.md';
    files.set(path, { bytes: enc('original'), mtime: 1000, size: 8 });

    const { revision, ciphertexts } = buildRemoteRevision('rev-new', enc('remote content'));
    const rest = stubRest(path, revision, ciphertexts);
    const realGetChunk = rest.getChunk.bind(rest);
    rest.getChunk = async (...args) => {
      const result = await realGetChunk(...args);
      files.set(path, { bytes: enc('edited during download'), mtime: 5000, size: 23 });
      return result;
    };

    const index = new IndexStore(
      { exists: async () => false, read: async () => '[]', write: async () => {} } as never,
      'index.json',
    );
    await index.load();
    index.set({
      path,
      mtime: 1000,
      size: 8,
      lastSyncedRevisionId: 'rev-old',
      excluded: false,
      basePlaintext: null, // no merge base — would otherwise go straight to conflictFile
      contentHash: null,
    });

    const engine = buildEngine(scope, rest, index) as unknown as {
      fetchRemote: () => Promise<void>;
      merge: (path: string, remoteRevisionId: string) => Promise<void>;
    };
    await engine.fetchRemote();
    await engine.merge(path, 'rev-new');

    // Guard must fire before conflictFile ever runs: original path keeps the
    // edit, no conflict sibling was spawned from a stale snapshot, index
    // untouched.
    expect(dec(files.get(path)!.bytes)).toBe('edited during download');
    expect(files.size).toBe(1);
    expect(index.get(path)?.lastSyncedRevisionId).toBe('rev-old');
  });
});
