import type { LocalFile } from './planner';
import { CONFIG_WIRE_PREFIX, configCategoryOf } from './config-categories';

// Adapter-level file access for `.obsidian` settings sync. The vault layer
// (TFile/vault.getFiles) deliberately can't see the config dir, so config
// paths go through Obsidian's DataAdapter instead. Wire paths are canonical
// ('.obsidian/...') regardless of the local configDir name (which is
// customizable) — this class owns the mapping, and emits NFC-normalized
// forward-slash paths so pathHmac and encryptPath always see the same string
// on every platform.

/** Structural subset of Obsidian's DataAdapter — keeps this unit-testable. */
export interface ConfigAdapterFs {
  exists(normalizedPath: string): Promise<boolean>;
  stat(normalizedPath: string): Promise<{ type: string; mtime: number; size: number } | null>;
  list(normalizedPath: string): Promise<{ files: string[]; folders: string[] }>;
  readBinary(normalizedPath: string): Promise<ArrayBuffer>;
  writeBinary(normalizedPath: string, data: ArrayBuffer): Promise<void>;
  mkdir(normalizedPath: string): Promise<void>;
  remove(normalizedPath: string): Promise<void>;
  rmdir(normalizedPath: string, recursive: boolean): Promise<void>;
}

export class ConfigFs {
  /** This plugin's own dir in canonical form — the 'never' subtree. */
  readonly ownPluginCanonicalDir: string;

  constructor(
    private fs: ConfigAdapterFs,
    private localConfigDir: string,
    ownPluginDir: string,
  ) {
    this.localConfigDir = localConfigDir.replace(/\/+$/, '');
    this.ownPluginCanonicalDir = this.toCanonical(ownPluginDir);
  }

  toLocal(canonical: string): string {
    return `${this.localConfigDir}/${canonical.slice(CONFIG_WIRE_PREFIX.length)}`;
  }

  toCanonical(local: string): string {
    const normalized = local.normalize('NFC').replace(/\\/g, '/');
    const rest = normalized.startsWith(`${this.localConfigDir}/`)
      ? normalized.slice(this.localConfigDir.length + 1)
      : normalized === this.localConfigDir
        ? ''
        : normalized;
    return rest ? `${CONFIG_WIRE_PREFIX}${rest}` : CONFIG_WIRE_PREFIX.slice(0, -1);
  }

  /** Recursive walk; hard-excluded ('never') paths never leave this layer. */
  async scan(): Promise<LocalFile[]> {
    const out: LocalFile[] = [];
    if (await this.fs.exists(this.localConfigDir)) {
      await this.walk(this.localConfigDir, out);
    }
    return out;
  }

  private async walk(dir: string, out: LocalFile[]): Promise<void> {
    const { files, folders } = await this.fs.list(dir);
    for (const file of files) {
      const canonical = this.toCanonical(file);
      if (configCategoryOf(canonical, this.ownPluginCanonicalDir) === 'never') continue;
      const stat = await this.fs.stat(file);
      if (!stat || stat.type !== 'file') continue;
      out.push({ path: canonical, mtime: stat.mtime, size: stat.size });
    }
    for (const folder of folders) {
      // Prune 'never' subtrees (own plugin dir, junk-named dirs) at the
      // folder level so their contents are never even listed.
      if (configCategoryOf(this.toCanonical(folder), this.ownPluginCanonicalDir) === 'never') {
        continue;
      }
      await this.walk(folder, out);
    }
  }

  async stat(canonical: string): Promise<{ mtime: number; size: number } | null> {
    const stat = await this.fs.stat(this.toLocal(canonical));
    return stat && stat.type === 'file' ? { mtime: stat.mtime, size: stat.size } : null;
  }

  async read(canonical: string): Promise<Uint8Array> {
    return new Uint8Array(await this.fs.readBinary(this.toLocal(canonical)));
  }

  async write(canonical: string, bytes: Uint8Array): Promise<{ mtime: number; size: number }> {
    const local = this.toLocal(canonical);
    await this.ensureParents(local);
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    await this.fs.writeBinary(local, buffer);
    // The index must record the on-disk mtime or every rescan re-pushes.
    return (await this.stat(canonical)) ?? { mtime: Date.now(), size: bytes.byteLength };
  }

  async remove(canonical: string): Promise<void> {
    const local = this.toLocal(canonical);
    if (!(await this.fs.exists(local))) return;
    await this.fs.remove(local);
    await this.pruneEmptyParents(local);
  }

  private async ensureParents(local: string): Promise<void> {
    const parts = local.split('/');
    // Walk down from configDir, creating each missing level (adapter.mkdir
    // is single-level on some platforms).
    const configDepth = this.localConfigDir.split('/').length;
    for (let depth = configDepth + 1; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join('/');
      if (!(await this.fs.exists(dir))) await this.fs.mkdir(dir);
    }
  }

  /**
   * Best-effort: a fully-deleted plugin shouldn't leave an empty
   * plugins/<id>/ husk behind. Stops at (never removes) configDir itself;
   * any error just stops the pruning.
   */
  private async pruneEmptyParents(local: string): Promise<void> {
    try {
      let dir = local.slice(0, local.lastIndexOf('/'));
      while (dir.length > this.localConfigDir.length) {
        const { files, folders } = await this.fs.list(dir);
        if (files.length > 0 || folders.length > 0) return;
        await this.fs.rmdir(dir, false);
        dir = dir.slice(0, dir.lastIndexOf('/'));
      }
    } catch {
      // Pruning is cosmetic; never fail the delete over it.
    }
  }
}
