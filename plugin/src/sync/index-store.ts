// Local sync index, persisted in the plugin data dir via Obsidian adapter
// APIs (mobile-safe; hard rule 2). Must itself never be synced.
//
// Per file: path, mtime, size, content hash, last-synced revision id,
// excluded flag (selective sync: excluded files stop syncing — divergence is
// expected there and must not be read as delete/new), and the merge base:
// plaintext cached for merge-eligible text files under the size cap, hash +
// revision id only otherwise (base is re-fetched from history on demand).

export interface IndexEntry {
  path: string;
  mtime: number;
  size: number;
  contentHash: string;
  lastSyncedRevisionId: string | null;
  excluded: boolean;
  basePlaintext: string | null;
}

export {};
