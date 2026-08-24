import { describe, expect, it } from 'vitest';
import type { DataAdapter } from 'obsidian';
import { IndexStore } from './index-store';

function fakeAdapter(initial: string | null): DataAdapter {
  let content = initial;
  return {
    exists: async () => content !== null,
    read: async () => content!,
    write: async (_path: string, data: string) => {
      content = data;
    },
  } as unknown as DataAdapter;
}

describe('IndexStore migration', () => {
  it('normalizes pre-migration entries (no contentHash key) to null on load', async () => {
    const legacy = JSON.stringify([
      {
        path: 'a.md',
        mtime: 1000,
        size: 10,
        lastSyncedRevisionId: 'rev-a',
        excluded: false,
        basePlaintext: null,
        // no contentHash key at all — this is what pre-upgrade index files look like
      },
    ]);
    const store = new IndexStore(fakeAdapter(legacy), 'index.json');
    await store.load();
    expect(store.get('a.md')?.contentHash).toBeNull();
  });

  it('round-trips a modern entry with contentHash intact', async () => {
    const store = new IndexStore(fakeAdapter(null), 'index.json');
    await store.load();
    store.set({
      path: 'a.md',
      mtime: 1000,
      size: 10,
      lastSyncedRevisionId: 'rev-a',
      excluded: false,
      basePlaintext: null,
      contentHash: 'abc123',
    });
    await store.persist();

    const reloaded = new IndexStore(fakeAdapter(JSON.stringify(store.all())), 'index.json');
    await reloaded.load();
    expect(reloaded.get('a.md')?.contentHash).toBe('abc123');
  });
});
