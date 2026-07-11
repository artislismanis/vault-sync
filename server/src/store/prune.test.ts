import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, Db } from './db';
import { memoryStore } from '../test-util/memory-store';
import {
  indexItem,
  indexRevision,
  writeItemSidecar,
  writeRevisionSidecar,
  chunkKey,
  revisionMetaKey,
  RevisionRecord,
} from './metadata-log';
import { findPruneCandidates, pruneRevisions } from './prune';

const VAULT = 'vault-1';
const ITEM = 'item-1';

const revision = (id: string, parentIds: string[], receivedAt: string, deleted = false): RevisionRecord => ({
  id,
  vaultId: VAULT,
  itemId: ITEM,
  parentIds,
  sizeBytes: deleted ? 0 : 8,
  deviceId: 'dev-1',
  clientMtime: receivedAt,
  serverReceivedAt: receivedAt,
  deleted,
  ...(deleted ? {} : { chunks: 1, streamHeaderB64: 'aGVhZGVy' }),
});

describe('prune', () => {
  let db: Db;
  let dataDir: string;
  const store = memoryStore();

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'vault-sync-prune-'));
    db = openDb(dataDir);
    db.prepare(
      "INSERT INTO vault (id, encrypted_name_b64, kdf_json, wrapped_vmk_b64, created_at) VALUES (?, 'x', '{}', 'x', '2026-01-01')",
    ).run(VAULT);
    const item = { id: ITEM, vaultId: VAULT, pathHmac: 'a'.repeat(64), encryptedPathB64: 'cA==' };
    await writeItemSidecar(store, item);
    indexItem(db, item);

    // Chain: r1 (old) <- r2 (old) <- r3 (recent head).
    const chain = [
      revision('r1', [], '2026-01-01T00:00:00.000Z'),
      revision('r2', ['r1'], '2026-02-01T00:00:00.000Z'),
      revision('r3', ['r2'], '2026-07-01T00:00:00.000Z'),
    ];
    for (const record of chain) {
      await store.put(chunkKey(VAULT, record.id, 0), `cipher-${record.id}`);
      await writeRevisionSidecar(store, record);
      indexRevision(db, record);
    }
  });

  afterAll(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('selects only old non-head revisions', () => {
    // Cutoff after r2 but heads are protected regardless of age.
    const candidates = findPruneCandidates(db, '2026-06-01T00:00:00.000Z');
    expect(candidates.map((c) => c.id)).toEqual(['r1', 'r2']);
    // A cutoff older than everything selects nothing.
    expect(findPruneCandidates(db, '2025-01-01T00:00:00.000Z')).toEqual([]);
    // Vault filter.
    expect(findPruneCandidates(db, '2026-06-01T00:00:00.000Z', 'other-vault')).toEqual([]);
  });

  it('never selects a head even when it is ancient', () => {
    const candidates = findPruneCandidates(db, '2099-01-01T00:00:00.000Z');
    expect(candidates.map((c) => c.id)).toEqual(['r1', 'r2']);
  });

  it('removes blobs, sidecars, and index rows; keeps the head intact', async () => {
    const candidates = findPruneCandidates(db, '2026-06-01T00:00:00.000Z');
    const result = await pruneRevisions(store, db, candidates);
    expect(result.revisions).toBe(2);

    expect(store.objects.has(chunkKey(VAULT, 'r1', 0))).toBe(false);
    expect(store.objects.has(revisionMetaKey(VAULT, 'r2'))).toBe(false);
    expect(store.objects.has(chunkKey(VAULT, 'r3', 0))).toBe(true);
    expect(store.objects.has(revisionMetaKey(VAULT, 'r3'))).toBe(true);

    const remaining = db.prepare('SELECT id FROM revision ORDER BY id').all() as { id: string }[];
    expect(remaining.map((r) => r.id)).toEqual(['r3']);
    // r3 still computes as the head despite its parent being gone.
    const heads = db
      .prepare(
        `SELECT r.id FROM revision r WHERE r.item_id = ? AND NOT EXISTS (
           SELECT 1 FROM revision r2, json_each(r2.parent_ids_json) p
           WHERE r2.item_id = r.item_id AND p.value = r.id)`,
      )
      .all(ITEM) as { id: string }[];
    expect(heads.map((h) => h.id)).toEqual(['r3']);
  });
});
