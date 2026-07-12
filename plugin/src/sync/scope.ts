import type { TFile, Vault } from 'obsidian';
import type { LocalFile } from './planner';
import { ConfigFs } from './config-fs';
import { isConfigPath } from './config-categories';
import { isUnderAnyMount, joinMount, stripMount } from './mount-paths';

// Filesystem seam between the engine and local storage. The engine operates
// entirely in ENGINE-DOMAIN paths — vault-relative for the main connection
// (plus canonical '.obsidian/...' for config), MOUNT-RELATIVE for folder
// connections — and this seam owns the local↔engine mapping. Keeping the
// engine single-domain is what makes path-misrouting bugs structurally
// impossible: EngineOptions has no Vault, so every filesystem touch goes
// through here.

export interface FileStat {
  mtime: number;
  size: number;
}

export interface SyncScope {
  /** Every in-scope file, engine-domain paths. */
  scan(): Promise<LocalFile[]>;
  stat(path: string): Promise<FileStat | null>;
  /** null = vanished between scan and execution; the next pass reconciles. */
  read(path: string): Promise<Uint8Array | null>;
  /** Creates parent folders; returns the on-disk stat. */
  write(path: string, bytes: Uint8Array): Promise<FileStat>;
  /** Recoverable removal (vault .trash; config files have server history). */
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /**
   * Structural exclusions composed with the category filter: the main scope
   * excludes everything under a mounted prefix (a folder connection owns it);
   * mount scopes exclude '.obsidian/*' (a shared vault must never be able to
   * write into the real config dir).
   */
  isPolicyExcluded(path: string): boolean;
  /** False ⇒ the engine skips the pass (mount-folder-missing guard). */
  isRootPresent(): Promise<boolean>;
  /** Engine-domain → local vault path, for logs, notices, and history UI. */
  toLocalPath(path: string): string;
}

export interface VaultScopeOptions {
  vault: Vault;
  /** '' = whole vault (main connection); e.g. 'Shared/Reference' = mount root. */
  mountPath: string;
  /**
   * Obsidian's normalizePath (slash/casing/Unicode normalization). Injected
   * rather than imported so this module stays unit-testable without the
   * 'obsidian' runtime (which only exists inside the Obsidian app).
   */
  normalizePath: (path: string) => string;
  /** Main connection only: config-dir access for settings sync. */
  configFs?: ConfigFs;
  getSettingsSyncEnabled?: () => boolean;
  /** Main connection only: live mounted prefixes to exclude from this scope. */
  getMountPrefixes?: () => string[];
}

export class VaultScope implements SyncScope {
  constructor(private opts: VaultScopeOptions) {}

  private get isMount(): boolean {
    return this.opts.mountPath !== '';
  }

  toLocalPath(path: string): string {
    return this.isMount ? joinMount(this.opts.mountPath, path) : path;
  }

  /** Config paths route through ConfigFs — main connection only. */
  private useConfig(path: string): boolean {
    return !this.isMount && isConfigPath(path) && this.opts.configFs !== undefined;
  }

  private fileFor(path: string): TFile | null {
    return this.opts.vault.getFileByPath(this.opts.normalizePath(this.toLocalPath(path)));
  }

  async scan(): Promise<LocalFile[]> {
    const { vault, mountPath } = this.opts;
    if (!this.isMount) {
      // vault.getFiles() covers every file in the vault folder (not .obsidian,
      // not dot-dirs) regardless of how it got there — external edits included.
      const local: LocalFile[] = vault.getFiles().map((f) => ({
        path: f.path,
        mtime: f.stat.mtime,
        size: f.stat.size,
      }));
      if (this.opts.getSettingsSyncEnabled?.() && this.opts.configFs) {
        // Config dir walk (adapter-level; no TFiles there). When the toggle
        // is off, stale config index entries and remote config heads flow
        // through the planner's exclusion path — stop-updating, never delete.
        local.push(...(await this.opts.configFs.scan()));
      }
      return local;
    }
    const out: LocalFile[] = [];
    for (const f of vault.getFiles()) {
      const enginePath = stripMount(mountPath, f.path);
      if (enginePath !== null) {
        out.push({ path: enginePath, mtime: f.stat.mtime, size: f.stat.size });
      }
    }
    return out;
  }

  isPolicyExcluded(path: string): boolean {
    if (this.isMount) return isConfigPath(path);
    const mounts = this.opts.getMountPrefixes?.() ?? [];
    return mounts.length > 0 && isUnderAnyMount(path, mounts);
  }

  async isRootPresent(): Promise<boolean> {
    if (!this.isMount) return true;
    return this.opts.vault.getFolderByPath(this.opts.normalizePath(this.opts.mountPath)) !== null;
  }

  async stat(path: string): Promise<FileStat | null> {
    if (this.useConfig(path)) return this.opts.configFs!.stat(path);
    return this.fileFor(path)?.stat ?? null;
  }

  async read(path: string): Promise<Uint8Array | null> {
    if (this.useConfig(path)) {
      if ((await this.opts.configFs!.stat(path)) === null) return null;
      return this.opts.configFs!.read(path);
    }
    const file = this.fileFor(path);
    if (!file) return null;
    return new Uint8Array(await this.opts.vault.readBinary(file));
  }

  async write(path: string, bytes: Uint8Array): Promise<FileStat> {
    if (this.useConfig(path)) return this.opts.configFs!.write(path, bytes);
    const { vault } = this.opts;
    const normalized = this.opts.normalizePath(this.toLocalPath(path));
    await this.ensureParentFolders(normalized);
    const existing = vault.getFileByPath(normalized);
    // Avoid a full copy when the view already spans its whole buffer
    // (always true for readBlob output — this matters at 500 MB).
    const spansBuffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    const buffer = spansBuffer
      ? (bytes.buffer as ArrayBuffer)
      : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    if (existing) {
      await vault.modifyBinary(existing, buffer);
      return existing.stat;
    }
    return (await vault.createBinary(normalized, buffer)).stat;
  }

  async remove(path: string): Promise<void> {
    if (this.useConfig(path)) return this.opts.configFs!.remove(path);
    const file = this.fileFor(path);
    // Vault-local trash: recoverable, and .trash is outside getFiles().
    if (file) await this.opts.vault.trash(file, false);
  }

  async exists(path: string): Promise<boolean> {
    if (this.useConfig(path)) return (await this.opts.configFs!.stat(path)) !== null;
    return this.fileFor(path) !== null;
  }

  private async ensureParentFolders(localPath: string): Promise<void> {
    const parts = localPath.split('/').slice(0, -1);
    if (parts.length === 0) return;
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.opts.vault.getFolderByPath(current)) {
        try {
          await this.opts.vault.createFolder(current);
        } catch {
          // races with Obsidian creating it are fine
        }
      }
    }
  }
}
