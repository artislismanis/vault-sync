import { describe, expect, it } from 'vitest';
import { ChunkSpool, SpoolFs } from './spool';

function fakeFs(): SpoolFs & { paths: Map<string, ArrayBuffer> } {
  const paths = new Map<string, ArrayBuffer>();
  const dirs = new Set<string>();
  return {
    paths,
    async exists(p) {
      return paths.has(p) || dirs.has(p);
    },
    async mkdir(p) {
      dirs.add(p);
    },
    async writeBinary(p, data) {
      paths.set(p, data);
    },
    async readBinary(p) {
      const data = paths.get(p);
      if (!data) throw new Error(`missing ${p}`);
      return data;
    },
    async rmdir(p, _recursive) {
      dirs.delete(p);
      for (const key of [...paths.keys()]) if (key.startsWith(`${p}/`)) paths.delete(key);
    },
    async list(p) {
      const folders = [...dirs].filter((d) => d.startsWith(`${p}/`) && !d.slice(p.length + 1).includes('/'));
      return { files: [], folders };
    },
  };
}

const REV_A = 'rev-aaaa';
const REV_B = 'rev-bbbb';

describe('ChunkSpool', () => {
  it('round-trips chunks and reports presence', async () => {
    const spool = new ChunkSpool(fakeFs(), '.obsidian/plugins/vault-sync/spool');
    expect(await spool.has(REV_A, 0)).toBe(false);
    await spool.write(REV_A, 0, new Uint8Array([1, 2, 3]));
    expect(await spool.has(REV_A, 0)).toBe(true);
    expect(await spool.has(REV_A, 1)).toBe(false);
    expect([...(await spool.read(REV_A, 0))]).toEqual([1, 2, 3]);
  });

  it('clear removes exactly one revision spool', async () => {
    const fs = fakeFs();
    const spool = new ChunkSpool(fs, 'spool');
    await spool.write(REV_A, 0, new Uint8Array([1]));
    await spool.write(REV_B, 0, new Uint8Array([2]));
    await spool.clear(REV_A);
    expect(await spool.has(REV_A, 0)).toBe(false);
    expect(await spool.has(REV_B, 0)).toBe(true);
  });

  it('retainOnly drops spools for superseded revisions', async () => {
    const fs = fakeFs();
    const spool = new ChunkSpool(fs, 'spool');
    await spool.write(REV_A, 0, new Uint8Array([1]));
    await spool.write(REV_B, 0, new Uint8Array([2]));
    await spool.retainOnly(new Set([REV_B]));
    expect(await spool.has(REV_A, 0)).toBe(false);
    expect(await spool.has(REV_B, 0)).toBe(true);
    // No spool root at all is a no-op.
    await new ChunkSpool(fakeFs(), 'spool').retainOnly(new Set());
  });
});
