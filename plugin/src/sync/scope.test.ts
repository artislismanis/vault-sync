import { describe, expect, it } from 'vitest';
import type { Vault } from 'obsidian';
import { VaultScope } from './scope';

// Minimal fake of the Vault surface VaultScope touches. TFile-ish objects
// are plain {path, stat}; folders are tracked as a path set.
function fakeVault(initialFiles: Record<string, { mtime: number; size: number }> = {}) {
  const files = new Map(
    Object.entries(initialFiles).map(([path, stat]) => [
      path,
      { path, stat: { ...stat }, content: new Uint8Array([1]) },
    ]),
  );
  const folders = new Set<string>();
  for (const path of files.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  const trashed: string[] = [];

  const vault = {
    files,
    folders,
    trashed,
    getFiles: () => [...files.values()],
    getFileByPath: (p: string) => files.get(p) ?? null,
    getFolderByPath: (p: string) => (folders.has(p) ? { path: p } : null),
    createFolder: async (p: string) => void folders.add(p),
    readBinary: async (f: { content: Uint8Array }) => f.content.buffer,
    modifyBinary: async (
      f: { path: string; stat: { mtime: number; size: number } },
      data: ArrayBuffer,
    ) => {
      f.stat = { mtime: 999, size: data.byteLength };
      files.get(f.path)!.stat = f.stat;
    },
    createBinary: async (p: string, data: ArrayBuffer) => {
      const file = {
        path: p,
        stat: { mtime: 999, size: data.byteLength },
        content: new Uint8Array(data),
      };
      files.set(p, file);
      return file;
    },
    trash: async (f: { path: string }) => {
      files.delete(f.path);
      trashed.push(f.path);
    },
  };
  return vault as unknown as Vault & typeof vault;
}

describe('VaultScope — mount mode', () => {
  const seed = {
    'Reference/notes/x.md': { mtime: 1, size: 10 },
    'Reference/y.md': { mtime: 2, size: 20 },
    'Other/z.md': { mtime: 3, size: 30 },
    'ReferenceBooks/near.md': { mtime: 4, size: 40 },
  };

  it('scans only the mounted subtree, emitting engine-domain paths', async () => {
    const scope = new VaultScope({
      vault: fakeVault(seed),
      mountPath: 'Reference',
      normalizePath: (p) => p,
    });
    const paths = (await scope.scan()).map((f) => f.path).sort();
    expect(paths).toEqual(['notes/x.md', 'y.md']);
  });

  it('maps engine paths back to local for I/O and display', async () => {
    const vault = fakeVault(seed);
    const scope = new VaultScope({ vault, mountPath: 'Reference', normalizePath: (p) => p });
    expect(scope.toLocalPath('notes/x.md')).toBe('Reference/notes/x.md');
    expect(await scope.stat('notes/x.md')).toEqual({ mtime: 1, size: 10 });
    expect(await scope.exists('y.md')).toBe(true);
    expect(await scope.exists('z.md')).toBe(false); // Other/z.md is outside
    expect(await scope.read('notes/x.md')).not.toBeNull();
  });

  it('write creates parent folders under the mount and returns the stat', async () => {
    const vault = fakeVault(seed);
    const scope = new VaultScope({ vault, mountPath: 'Reference', normalizePath: (p) => p });
    const stat = await scope.write('deep/new.md', new Uint8Array([1, 2, 3]));
    expect(stat.size).toBe(3);
    expect(vault.files.has('Reference/deep/new.md')).toBe(true);
    expect(vault.folders.has('Reference/deep')).toBe(true);
  });

  it('remove trashes the local file', async () => {
    const vault = fakeVault(seed);
    const scope = new VaultScope({ vault, mountPath: 'Reference', normalizePath: (p) => p });
    await scope.remove('y.md');
    expect(vault.trashed).toEqual(['Reference/y.md']);
    await scope.remove('missing.md'); // no-op
  });

  it('policy-excludes .obsidian paths (config-write injection guard)', () => {
    const scope = new VaultScope({
      vault: fakeVault(),
      mountPath: 'Reference',
      normalizePath: (p) => p,
    });
    expect(scope.isPolicyExcluded('.obsidian/app.json')).toBe(true);
    expect(scope.isPolicyExcluded('.obsidian/plugins/x/main.js')).toBe(true);
    expect(scope.isPolicyExcluded('notes/x.md')).toBe(false);
  });

  it('isRootPresent tracks the mount folder', async () => {
    const vault = fakeVault(seed);
    const scope = new VaultScope({ vault, mountPath: 'Reference', normalizePath: (p) => p });
    expect(await scope.isRootPresent()).toBe(true);
    vault.folders.delete('Reference');
    expect(await scope.isRootPresent()).toBe(false);
    const missing = new VaultScope({ vault, mountPath: 'Nowhere', normalizePath: (p) => p });
    expect(await missing.isRootPresent()).toBe(false);
  });
});

describe('VaultScope — whole-vault mode', () => {
  const seed = {
    'notes/a.md': { mtime: 1, size: 10 },
    'Reference/x.md': { mtime: 2, size: 20 },
  };

  it('scans everything verbatim and is always root-present', async () => {
    const scope = new VaultScope({
      vault: fakeVault(seed),
      mountPath: '',
      normalizePath: (p) => p,
    });
    const paths = (await scope.scan()).map((f) => f.path).sort();
    expect(paths).toEqual(['Reference/x.md', 'notes/a.md']);
    expect(await scope.isRootPresent()).toBe(true);
    expect(scope.toLocalPath('notes/a.md')).toBe('notes/a.md');
  });

  it('policy-excludes mounted prefixes (root and children), live', () => {
    let mounts: string[] = [];
    const scope = new VaultScope({
      vault: fakeVault(seed),
      mountPath: '',
      normalizePath: (p) => p,
      getMountPrefixes: () => mounts,
    });
    expect(scope.isPolicyExcluded('Reference/x.md')).toBe(false);
    mounts = ['Reference'];
    expect(scope.isPolicyExcluded('Reference')).toBe(true);
    expect(scope.isPolicyExcluded('Reference/x.md')).toBe(true);
    expect(scope.isPolicyExcluded('ReferenceBooks/y.md')).toBe(false);
    expect(scope.isPolicyExcluded('notes/a.md')).toBe(false);
  });
});
