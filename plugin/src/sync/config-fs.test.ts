import { describe, expect, it } from 'vitest';
import { ConfigAdapterFs, ConfigFs } from './config-fs';

/** In-memory fake DataAdapter: files map + implicit dirs from paths. */
function fakeFs(initial: Record<string, { mtime: number; size: number }> = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set<string>();
  const parentDirsOf = (path: string) => {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  };
  for (const path of files.keys()) parentDirsOf(path);

  const fs: ConfigAdapterFs & { files: typeof files; dirs: typeof dirs } = {
    files,
    dirs,
    async exists(p) {
      return files.has(p) || dirs.has(p);
    },
    async stat(p) {
      const f = files.get(p);
      if (f) return { type: 'file', mtime: f.mtime, size: f.size };
      return dirs.has(p) ? { type: 'folder', mtime: 0, size: 0 } : null;
    },
    async list(p) {
      const direct = (paths: Iterable<string>) =>
        [...paths].filter((k) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/'));
      return { files: direct(files.keys()), folders: direct(dirs) };
    },
    async readBinary(p) {
      if (!files.has(p)) throw new Error(`missing ${p}`);
      return new ArrayBuffer(files.get(p)!.size);
    },
    async writeBinary(p, data) {
      files.set(p, { mtime: 1_000_000, size: data.byteLength });
      parentDirsOf(p);
    },
    async mkdir(p) {
      dirs.add(p);
    },
    async remove(p) {
      files.delete(p);
    },
    async rmdir(p, recursive) {
      if (!recursive) {
        const { files: f, folders: d } = await fs.list(p);
        if (f.length || d.length) throw new Error('not empty');
      }
      dirs.delete(p);
    },
  };
  return fs;
}

const OWN_PLUGIN_DIR = '.obsidian/plugins/vault-sync';

describe('ConfigFs.scan', () => {
  it('walks recursively, emits canonical paths, filters hard exclusions', async () => {
    const fs = fakeFs({
      '.obsidian/app.json': { mtime: 1, size: 10 },
      '.obsidian/workspace.json': { mtime: 2, size: 20 },
      '.obsidian/themes/Minimal/theme.css': { mtime: 3, size: 30 },
      '.obsidian/plugins/dataview/data.json': { mtime: 4, size: 40 },
      '.obsidian/plugins/vault-sync/data.json': { mtime: 5, size: 50 },
      '.obsidian/plugins/vault-sync/spool/rev/00000': { mtime: 6, size: 60 },
      'notes/todo.md': { mtime: 7, size: 70 },
    });
    const configFs = new ConfigFs(fs, '.obsidian', OWN_PLUGIN_DIR);
    const paths = (await configFs.scan()).map((f) => f.path).sort();
    expect(paths).toEqual([
      '.obsidian/app.json',
      '.obsidian/plugins/dataview/data.json',
      '.obsidian/themes/Minimal/theme.css',
    ]);
  });

  it('returns empty when the config dir does not exist', async () => {
    const configFs = new ConfigFs(fakeFs(), '.obsidian', OWN_PLUGIN_DIR);
    expect(await configFs.scan()).toEqual([]);
  });
});

describe('canonical ↔ local mapping with a non-default configDir', () => {
  const fs = fakeFs({ '.config-obsidian/app.json': { mtime: 1, size: 10 } });
  const configFs = new ConfigFs(fs, '.config-obsidian', '.config-obsidian/plugins/vault-sync');

  it('scan emits canonical .obsidian/ paths', async () => {
    expect((await configFs.scan()).map((f) => f.path)).toEqual(['.obsidian/app.json']);
  });

  it('toLocal maps canonical back to the real dir', () => {
    expect(configFs.toLocal('.obsidian/app.json')).toBe('.config-obsidian/app.json');
  });

  it('ownPluginCanonicalDir is remapped to canonical form', () => {
    expect(configFs.ownPluginCanonicalDir).toBe('.obsidian/plugins/vault-sync');
  });

  it('read/stat resolve through the mapping', async () => {
    expect(await configFs.stat('.obsidian/app.json')).toEqual({ mtime: 1, size: 10 });
    expect((await configFs.read('.obsidian/app.json')).byteLength).toBe(10);
  });
});

describe('normalization', () => {
  it('toCanonical applies NFC and forward slashes', () => {
    const configFs = new ConfigFs(fakeFs(), '.obsidian', OWN_PLUGIN_DIR);
    const nfd = '.obsidian/themes/Café/theme.css'; // é as e + combining accent
    const canonical = configFs.toCanonical(nfd.replace(/\//g, '\\'));
    expect(canonical).toBe('.obsidian/themes/Café/theme.css'); // precomposed é
  });
});

describe('write', () => {
  it('creates parent directories and returns on-disk stat', async () => {
    const fs = fakeFs();
    fs.dirs.add('.obsidian');
    const configFs = new ConfigFs(fs, '.obsidian', OWN_PLUGIN_DIR);
    const stat = await configFs.write(
      '.obsidian/plugins/new-plugin/data.json',
      new Uint8Array([1, 2, 3]),
    );
    expect(stat).toEqual({ mtime: 1_000_000, size: 3 });
    expect(fs.dirs.has('.obsidian/plugins')).toBe(true);
    expect(fs.dirs.has('.obsidian/plugins/new-plugin')).toBe(true);
    expect(fs.files.has('.obsidian/plugins/new-plugin/data.json')).toBe(true);
  });
});

describe('remove', () => {
  it('removes the file and prunes now-empty parents, stopping at configDir', async () => {
    const fs = fakeFs({
      '.obsidian/plugins/gone/main.js': { mtime: 1, size: 1 },
      '.obsidian/app.json': { mtime: 2, size: 2 },
    });
    const configFs = new ConfigFs(fs, '.obsidian', OWN_PLUGIN_DIR);
    await configFs.remove('.obsidian/plugins/gone/main.js');
    expect(fs.files.has('.obsidian/plugins/gone/main.js')).toBe(false);
    expect(fs.dirs.has('.obsidian/plugins/gone')).toBe(false);
    expect(fs.dirs.has('.obsidian/plugins')).toBe(false);
    expect(fs.dirs.has('.obsidian')).toBe(true); // never removes configDir
    expect(fs.files.has('.obsidian/app.json')).toBe(true);
  });

  it('keeps parents that still have content', async () => {
    const fs = fakeFs({
      '.obsidian/plugins/keep/main.js': { mtime: 1, size: 1 },
      '.obsidian/plugins/keep/data.json': { mtime: 2, size: 2 },
    });
    const configFs = new ConfigFs(fs, '.obsidian', OWN_PLUGIN_DIR);
    await configFs.remove('.obsidian/plugins/keep/main.js');
    expect(fs.dirs.has('.obsidian/plugins/keep')).toBe(true);
    expect(fs.files.has('.obsidian/plugins/keep/data.json')).toBe(true);
  });

  it('is a no-op for missing files', async () => {
    const configFs = new ConfigFs(fakeFs(), '.obsidian', OWN_PLUGIN_DIR);
    await expect(configFs.remove('.obsidian/nope.json')).resolves.toBeUndefined();
  });
});
