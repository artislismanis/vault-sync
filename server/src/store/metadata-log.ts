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

export function vaultMetaKey(vaultId: string): string {
  return `meta/vaults/${vaultId}.json`;
}

export async function writeVaultSidecar(store: ObjectStore, record: VaultRecord): Promise<void> {
  await store.put(vaultMetaKey(record.id), JSON.stringify(record));
}

export function indexVault(db: Db, record: VaultRecord): void {
  db.prepare(
    `INSERT OR REPLACE INTO vault (id, encrypted_name_b64, kdf_json, wrapped_vmk_b64, created_at)
     VALUES (@id, @encryptedNameB64, @kdfJson, @wrappedVmkB64, @createdAt)`,
  ).run(record);
}

/** Rebuild the SQLite index from the bucket's sidecars. Wipes derived tables first. */
export async function rebuildIndex(store: ObjectStore, db: Db): Promise<{ vaults: number }> {
  db.exec('DELETE FROM revision; DELETE FROM item; DELETE FROM vault;');
  let vaults = 0;
  for (const key of await store.list('meta/vaults/')) {
    const record = JSON.parse(new TextDecoder().decode(await store.get(key))) as VaultRecord;
    indexVault(db, record);
    vaults++;
  }
  // TODO(sync-engine): rebuild item + revision tables from meta/{vaultId}/…
  // sidecars when those write paths land.
  return { vaults };
}
