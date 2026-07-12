import type { ObjectStore } from './s3';
import type { Db } from './db';

// Write-ahead metadata sidecars (docs/decisions.md): every accepted write is
// first persisted as an immutable JSON object in the bucket, THEN indexed in
// SQLite, THEN acked. "Back up the bucket" is therefore a complete backup,
// and the index is reconstructible from a bucket scan.
//
// Key layout:
//   meta/vaults/{vaultId}.json                 vault record (kdf, wrapped VMK, encrypted name)
//   meta/{vaultId}/items/{itemId}.json         item record (path hmac, encrypted path)
//   meta/{vaultId}/revisions/{revisionId}.json revision record (parents, size, timestamps)
//   blobs/{vaultId}/{revisionId}               ciphertext

export interface VaultRecord {
  id: string;
  encryptedNameB64: string;
  kdfJson: string;
  wrappedVmkB64: string;
  createdAt: string;
}

export interface ItemRecord {
  id: string;
  vaultId: string;
  pathHmac: string;
  encryptedPathB64: string;
}

export interface RevisionRecord {
  id: string;
  vaultId: string;
  itemId: string;
  parentIds: string[];
  sizeBytes: number;
  deviceId: string;
  clientMtime: string;
  serverReceivedAt: string;
  deleted: boolean;
  // Blob format v2 (absent = legacy v1 single blob).
  chunks?: number;
  streamHeaderB64?: string;
}

export function vaultMetaKey(vaultId: string): string {
  return `meta/vaults/${vaultId}.json`;
}

export function itemMetaKey(vaultId: string, itemId: string): string {
  return `meta/${vaultId}/items/${itemId}.json`;
}

export function revisionMetaKey(vaultId: string, revisionId: string): string {
  return `meta/${vaultId}/revisions/${revisionId}.json`;
}

/** Legacy v1: single object per revision. */
export function blobKey(vaultId: string, revisionId: string): string {
  return `blobs/${vaultId}/${revisionId}`;
}

/** Blob format v2: one object per chunk. */
export function chunkKey(vaultId: string, revisionId: string, seq: number): string {
  return `${chunkPrefix(vaultId, revisionId)}${String(seq).padStart(5, '0')}`;
}

export function chunkPrefix(vaultId: string, revisionId: string): string {
  return `blobs/${vaultId}/${revisionId}/`;
}

export async function writeVaultSidecar(store: ObjectStore, record: VaultRecord): Promise<void> {
  await store.put(vaultMetaKey(record.id), JSON.stringify(record));
}

export async function writeItemSidecar(store: ObjectStore, record: ItemRecord): Promise<void> {
  await store.put(itemMetaKey(record.vaultId, record.id), JSON.stringify(record));
}

export async function writeRevisionSidecar(
  store: ObjectStore,
  record: RevisionRecord,
): Promise<void> {
  await store.put(revisionMetaKey(record.vaultId, record.id), JSON.stringify(record));
}

export function indexVault(db: Db, record: VaultRecord): void {
  db.prepare(
    `INSERT OR REPLACE INTO vault (id, encrypted_name_b64, kdf_json, wrapped_vmk_b64, created_at)
     VALUES (@id, @encryptedNameB64, @kdfJson, @wrappedVmkB64, @createdAt)`,
  ).run(record);
}

export function indexItem(db: Db, record: ItemRecord): void {
  db.prepare(
    `INSERT INTO item (id, vault_id, path_hmac, encrypted_path_b64)
     VALUES (@id, @vaultId, @pathHmac, @encryptedPathB64)
     ON CONFLICT(id) DO UPDATE SET encrypted_path_b64 = @encryptedPathB64`,
  ).run(record);
}

export function indexRevision(db: Db, record: RevisionRecord): void {
  db.prepare(
    `INSERT OR REPLACE INTO revision
       (id, item_id, parent_ids_json, size_bytes, device_id, client_mtime, server_received_at, deleted, chunks, stream_header_b64)
     VALUES (@id, @itemId, @parentIdsJson, @sizeBytes, @deviceId, @clientMtime, @serverReceivedAt, @deleted, @chunks, @streamHeaderB64)`,
  ).run({
    ...record,
    parentIdsJson: JSON.stringify(record.parentIds),
    deleted: record.deleted ? 1 : 0,
    chunks: record.chunks ?? null,
    streamHeaderB64: record.streamHeaderB64 ?? null,
  });
  // item.deleted caches the head state for cheap listing.
  db.prepare('UPDATE item SET deleted = ? WHERE id = ?').run(record.deleted ? 1 : 0, record.itemId);
}

/**
 * Permanently delete a vault: every sidecar, every blob, every index row.
 * Crash-safe order — children first, the vault record LAST: rebuild-index
 * enumerates vault records, so an interrupted run leaves a vault with missing
 * children (still listed, still deletable), never orphaned children invisible
 * to a rebuild.
 */
export async function deleteVault(
  store: ObjectStore,
  db: Db,
  vaultId: string,
): Promise<{ objects: number; revisions: number }> {
  let objects = 0;
  const prefixes = [`meta/${vaultId}/revisions/`, `meta/${vaultId}/items/`, `blobs/${vaultId}/`];
  for (const prefix of prefixes) {
    for (const key of await store.list(prefix)) {
      await store.delete(key);
      objects++;
    }
  }
  await store.delete(vaultMetaKey(vaultId));
  objects++;
  const revisions = db
    .prepare('DELETE FROM revision WHERE item_id IN (SELECT id FROM item WHERE vault_id = ?)')
    .run(vaultId).changes;
  db.prepare('DELETE FROM item WHERE vault_id = ?').run(vaultId);
  db.prepare('DELETE FROM vault WHERE id = ?').run(vaultId);
  return { objects, revisions };
}

/** Rebuild the SQLite index from the bucket's sidecars. Wipes derived tables first. */
export async function rebuildIndex(
  store: ObjectStore,
  db: Db,
): Promise<{ vaults: number; items: number; revisions: number }> {
  db.exec('DELETE FROM revision; DELETE FROM item; DELETE FROM vault;');
  const readJson = async <T>(key: string): Promise<T> =>
    JSON.parse(new TextDecoder().decode(await store.get(key))) as T;

  let vaults = 0;
  let items = 0;
  let revisions = 0;
  for (const vaultKey of await store.list('meta/vaults/')) {
    const vault = await readJson<VaultRecord>(vaultKey);
    indexVault(db, vault);
    vaults++;
    for (const itemKey of await store.list(`meta/${vault.id}/items/`)) {
      indexItem(db, await readJson<ItemRecord>(itemKey));
      items++;
    }
    // indexRevision keeps item.deleted in sync with the latest revision seen;
    // order within an item doesn't matter for heads (computed from the DAG),
    // but apply in serverReceivedAt order so the deleted cache lands right.
    const revisionRecords: RevisionRecord[] = [];
    for (const revKey of await store.list(`meta/${vault.id}/revisions/`)) {
      revisionRecords.push(await readJson<RevisionRecord>(revKey));
    }
    revisionRecords.sort((a, b) => a.serverReceivedAt.localeCompare(b.serverReceivedAt));
    for (const record of revisionRecords) {
      indexRevision(db, record);
      revisions++;
    }
  }
  return { vaults, items, revisions };
}
