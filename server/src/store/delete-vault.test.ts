import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, Db } from './db';
import {
  deleteVault,
  indexItem,
  indexRevision,
  indexVault,
  rebuildIndex,
  writeItemSidecar,
  writeRevisionSidecar,
  writeVaultSidecar,
  ItemRecord,
  RevisionRecord,
  VaultRecord,
} from './metadata-log';
import { memoryStore } from '../test-util/memory-store';

describe('deleteVault', () => {
  let dataDir: string;
  let db: Db;
  const store = memoryStore();

  const vault = (n: number): VaultRecord => ({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    encryptedNameB64: 'b3BhcXVl',
    kdfJson: '{}',
    wrappedVmkB64: 'b3BhcXVl',
    createdAt: '2026-07-01T00:00:00.000Z',
  });
  const item = (vaultId: string, n: number): ItemRecord => ({
    id: `00000000-0000-4000-8000-0000000001${n}0`,
    vaultId,
    pathHmac: `${n}`.repeat(64),
    encryptedPathB64: 'cGF0aA==',
  });
  const revision = (vaultId: string, itemId: string, n: number): RevisionRecord => ({
    id: `00000000-0000-4000-8000-0000000002${n}0`,
    vaultId,
    itemId,
    parentIds: [],
    sizeBytes: 4,
    deviceId: 'dev',
    clientMtime: '2026-07-01T00:00:00.000Z',
    serverReceivedAt: '2026-07-01T00:00:00.000Z',
    deleted: false,
  });

  async function seedVault(n: number): Promise<VaultRecord> {
    const v = vault(n);
    const i = item(v.id, n);
    const r = revision(v.id, i.id, n);
    await writeVaultSidecar(store, v);
    await writeItemSidecar(store, i);
    await writeRevisionSidecar(store, r);
    await store.put(`blobs/${v.id}/${r.id}/00000`, 'ciphertext');
    indexVault(db, v);
    indexItem(db, i);
    indexRevision(db, r);
    return v;
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'vault-sync-delete-'));
    db = openDb(dataDir);
  });

  afterAll(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('removes all sidecars, blobs, and index rows; leaves other vaults untouched', async () => {
    const doomed = await seedVault(1);
    const kept = await seedVault(2);

    const result = await deleteVault(store, db, doomed.id);
    expect(result.revisions).toBe(1);
    expect(result.objects).toBe(4); // revision + item sidecars, blob chunk, vault record

    expect([...store.objects.keys()].filter((k) => k.includes(doomed.id))).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM vault WHERE id = ?').get(doomed.id)).toEqual({
      n: 0,
    });

    // The other vault survives fully, in bucket and index.
    expect(await store.exists(`meta/vaults/${kept.id}.json`)).toBe(true);
    const counts = await rebuildIndex(store, db);
    expect(counts).toEqual({ vaults: 1, items: 1, revisions: 1 });
  });

  it('a partial delete (vault record still present) reconverges via rebuild-index', async () => {
    const v = await seedVault(3);
    // Simulate a crash after children were deleted but before the vault
    // record (the deletion order guarantees this is the only partial shape).
    for (const key of await store.list(`meta/${v.id}/`)) await store.delete(key);
    for (const key of await store.list(`blobs/${v.id}/`)) await store.delete(key);

    const counts = await rebuildIndex(store, db);
    expect(counts.vaults).toBe(2); // childless vault still enumerable…
    const rerun = await deleteVault(store, db, v.id);
    expect(rerun.revisions).toBe(0); // …and the re-run completes the delete
    expect(await store.exists(`meta/vaults/${v.id}.json`)).toBe(false);
    expect((await rebuildIndex(store, db)).vaults).toBe(1);
  });
});
