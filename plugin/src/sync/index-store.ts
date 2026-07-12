import type { DataAdapter } from 'obsidian';

// Local sync index, persisted in the plugin dir via Obsidian adapter APIs
// (mobile-safe; hard rule 2). Never synced itself.
//
// basePlaintext is the merge base: cached for merge-eligible text files under
// the size cap; null otherwise (binaries never text-merge; oversized bases
// are re-fetched from server history on demand).

export interface IndexEntry {
  path: string;
  mtime: number;
  size: number;
  // null for entries that are excluded without ever having synced
  // (e.g. oversized files hit by the size cap).
  lastSyncedRevisionId: string | null;
  excluded: boolean;
  basePlaintext: string | null;
}

export const BASE_CACHE_MAX_BYTES = 1024 * 1024;

// Merge POLICY only — which files diff3-merge and cache a base. Independent
// of selective-sync categories (categories.ts): a txt file is mergeable text
// but excludable under the "other" toggle. 'base' is Obsidian Bases (YAML).
const MERGEABLE_EXTENSIONS = new Set([
  'md',
  'txt',
  'json',
  'canvas',
  'base',
  'csv',
  'yml',
  'yaml',
  'org',
  'tex',
]);

export function isMergeableText(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MERGEABLE_EXTENSIONS.has(ext);
}

export class IndexStore {
  private entries = new Map<string, IndexEntry>();

  constructor(
    private adapter: DataAdapter,
    private filePath: string,
  ) {}

  static forVault(adapter: DataAdapter, pluginDir: string, vaultId: string): IndexStore {
    return new IndexStore(adapter, `${pluginDir}/sync-index-${vaultId}.json`);
  }

  async load(): Promise<void> {
    this.entries.clear();
    if (await this.adapter.exists(this.filePath)) {
      const raw = JSON.parse(await this.adapter.read(this.filePath)) as IndexEntry[];
      for (const entry of raw) this.entries.set(entry.path, entry);
    }
  }

  async persist(): Promise<void> {
    await this.adapter.write(this.filePath, JSON.stringify([...this.entries.values()]));
  }

  get(path: string): IndexEntry | undefined {
    return this.entries.get(path);
  }

  all(): IndexEntry[] {
    return [...this.entries.values()];
  }

  set(entry: IndexEntry): void {
    this.entries.set(entry.path, entry);
  }

  remove(path: string): void {
    this.entries.delete(path);
  }
}
