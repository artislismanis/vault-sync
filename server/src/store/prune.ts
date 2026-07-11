import type { ObjectStore } from './s3';
import type { Db } from './db';
import { blobKey, chunkPrefix, revisionMetaKey } from './metadata-log';

// Retention pruning (docs/sync-protocol.md "Version history"): removes old
// NON-HEAD revisions — ciphertext blobs, metadata sidecars, and index rows —
// operating purely on the revision DAG (no plaintext needed, E2EE intact).
// Heads (including tombstone heads) are never pruned, so current state and
// delete propagation are untouchable. Deleting a mid-chain revision leaves
// dangling parent ids in its children; head computation is unaffected and
// history listings simply get sparser.

export interface PruneCandidate {
  id: string;
  itemId: string;
  vaultId: string;
}

export function findPruneCandidates(
  db: Db,
  cutoffIso: string,
  vaultId: string | null = null,
): PruneCandidate[] {
  return db
    .prepare(
      `SELECT r.id AS id, r.item_id AS itemId, i.vault_id AS vaultId
       FROM revision r JOIN item i ON r.item_id = i.id
       WHERE r.server_received_at < @cutoff
         AND (@vaultId IS NULL OR i.vault_id = @vaultId)
         AND EXISTS (
           SELECT 1 FROM revision r2, json_each(r2.parent_ids_json) p
           WHERE r2.item_id = r.item_id AND p.value = r.id
         )
       ORDER BY r.server_received_at`,
    )
    .all({ cutoff: cutoffIso, vaultId }) as PruneCandidate[];
}

export async function pruneRevisions(
  store: ObjectStore,
  db: Db,
  candidates: PruneCandidate[],
): Promise<{ revisions: number; objects: number }> {
  let objects = 0;
  const deleteRow = db.prepare('DELETE FROM revision WHERE id = ?');
  for (const candidate of candidates) {
    for (const key of await store.list(chunkPrefix(candidate.vaultId, candidate.id))) {
      await store.delete(key);
      objects++;
    }
    const legacy = blobKey(candidate.vaultId, candidate.id);
    if (await store.exists(legacy)) {
      await store.delete(legacy);
      objects++;
    }
    await store.delete(revisionMetaKey(candidate.vaultId, candidate.id));
    objects++;
    deleteRow.run(candidate.id);
  }
  return { revisions: candidates.length, objects };
}
