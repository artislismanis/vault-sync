import { normalizePath as obsidianNormalizePath, TFile, Vault } from 'obsidian';
import {
  VaultKeys,
  decryptContent,
  decryptPath,
  encryptContent,
  encryptPath,
  pathHmac,
  ItemHeads,
} from '@vault-sync/shared';
import type { RestClient } from '../transport/rest';
import { IndexStore, isMergeableText, BASE_CACHE_MAX_BYTES } from './index-store';
import { planSync, Action, LocalFile, RemoteItem } from './planner';
import { threeWayMerge } from '../merge/diff3';

// Executes the planner's actions. Hard rule 4 discipline: every destructive
// local operation goes through vault.trash (recoverable), every push cites
// its parent (server history retains the prior version), and merge conflicts
// always produce a conflict file — never a silent discard.

const MAX_PASSES = 3;

export interface EngineOptions {
  vault: Vault;
  rest: RestClient;
  keys: VaultKeys;
  vaultId: string;
  deviceName: string;
  index: IndexStore;
  log: (message: string) => void;
}

export class SyncEngine {
  /** True while the engine itself writes files — vault-event handlers must ignore those. */
  applyingRemote = false;
  private running = false;
  private queued = false;

  constructor(private opts: EngineOptions) {}

  /** Debounce-friendly entry point: coalesces overlapping requests. */
  async requestSync(): Promise<void> {
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.queued = false;
        await this.fullSync();
      } while (this.queued);
    } finally {
      this.running = false;
    }
  }

  async fullSync(): Promise<void> {
    const { log } = this.opts;
    // Multiple passes: conflict files created in pass N are pushed in pass
    // N+1; a merge push also needs a follow-up heads check.
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const actions = await this.planOnce();
      if (actions.length === 0) {
        if (pass === 0) log('sync: up to date');
        return;
      }
      log(`sync: pass ${pass + 1}, ${actions.length} action(s)`);
      for (const action of actions) {
        await this.execute(action);
      }
      await this.opts.index.persist();
    }
  }

  private async planOnce(): Promise<Action[]> {
    const local = this.scanLocal();
    const remote = await this.fetchRemote();
    return planSync({ local, index: this.opts.index.all(), remote });
  }

  private scanLocal(): LocalFile[] {
    // vault.getFiles() covers every file in the vault folder (not .obsidian,
    // not dot-dirs) regardless of how it got there — external edits included.
    return this.opts.vault.getFiles().map((f) => ({
      path: f.path,
      mtime: f.stat.mtime,
      size: f.stat.size,
    }));
  }

  private remoteHeadsByPath = new Map<string, ItemHeads>();

  private async fetchRemote(): Promise<RemoteItem[]> {
    const response = await this.opts.rest.heads(this.opts.vaultId);
    this.remoteHeadsByPath.clear();
    const remote: RemoteItem[] = [];
    for (const item of response.items) {
      const path = decryptPath(this.opts.keys, item.encryptedPathB64);
      this.remoteHeadsByPath.set(path, item);
      remote.push({
        path,
        heads: item.heads.map((h) => ({ revisionId: h.id, deleted: h.deleted })),
      });
    }
    return remote;
  }

  private async execute(action: Action): Promise<void> {
    switch (action.kind) {
      case 'push':
        return this.push(action.path, action.parentIds);
      case 'pushDelete':
        return this.pushDelete(action.path, action.parentIds);
      case 'pull':
        return this.pull(action.path, action.revisionId);
      case 'deleteLocal':
        return this.deleteLocal(action.path);
      case 'merge':
        return this.merge(action.path, action.remoteRevisionId);
      case 'mergeHeads':
        return this.mergeHeads(action.path, action.headIds);
      case 'forgetIndex':
        this.opts.index.remove(action.path);
        return;
    }
  }

  // --- push side ---------------------------------------------------------

  private async push(path: string, parentIds: string[]): Promise<void> {
    const { vault, rest, keys, vaultId } = this.opts;
    const file = vault.getFileByPath(path);
    if (!file) return; // vanished between scan and execution; next pass handles it
    const plaintext = new Uint8Array(await vault.readBinary(file));
    const revisionId = crypto.randomUUID();
    await rest.putBlob(vaultId, revisionId, encryptContent(keys, plaintext));
    await rest.postRevision(vaultId, {
      id: revisionId,
      pathHmac: pathHmac(keys.macKey, path),
      encryptedPathB64: encryptPath(keys, path),
      parentIds,
      sizeBytes: plaintext.byteLength,
      clientMtime: new Date(file.stat.mtime).toISOString(),
      deleted: false,
    } as Parameters<RestClient['postRevision']>[1]);
    this.updateIndexAfterSync(path, file, plaintext, revisionId);
    this.opts.log(`pushed ${path}`);
  }

  private async pushDelete(path: string, parentIds: string[]): Promise<void> {
    const { rest, keys, vaultId } = this.opts;
    await rest.postRevision(vaultId, {
      id: crypto.randomUUID(),
      pathHmac: pathHmac(keys.macKey, path),
      encryptedPathB64: encryptPath(keys, path),
      parentIds,
      sizeBytes: 0,
      clientMtime: new Date().toISOString(),
      deleted: true,
    } as Parameters<RestClient['postRevision']>[1]);
    this.opts.index.remove(path);
    this.opts.log(`pushed delete of ${path}`);
  }

  // --- pull side ---------------------------------------------------------

  private async pull(path: string, revisionId: string): Promise<void> {
    const plaintext = decryptContent(
      this.opts.keys,
      await this.opts.rest.getBlob(this.opts.vaultId, revisionId),
    );
    const file = await this.writeLocal(path, plaintext);
    this.updateIndexAfterSync(path, file, plaintext, revisionId);
    this.opts.log(`pulled ${path}`);
  }

  private async deleteLocal(path: string): Promise<void> {
    const file = this.opts.vault.getFileByPath(path);
    if (file) {
      this.applyingRemote = true;
      try {
        // Vault-local trash: recoverable, and .trash is outside getFiles().
        await this.opts.vault.trash(file, false);
      } finally {
        this.applyingRemote = false;
      }
    }
    this.opts.index.remove(path);
    this.opts.log(`deleted ${path} (remote tombstone; local copy in .trash)`);
  }

  // --- merge side --------------------------------------------------------

  private async merge(path: string, remoteRevisionId: string): Promise<void> {
    const { vault, keys, rest, vaultId, index } = this.opts;
    const file = vault.getFileByPath(path);
    if (!file) return;
    const remoteBytes = decryptContent(keys, await rest.getBlob(vaultId, remoteRevisionId));
    const base = index.get(path)?.basePlaintext;

    if (isMergeableText(path) && base != null) {
      const localText = new TextDecoder().decode(
        new Uint8Array(await vault.readBinary(file)),
      );
      const remoteText = new TextDecoder().decode(remoteBytes);
      const result = threeWayMerge(base, localText, remoteText);
      if (result.ok) {
        const mergedBytes = new TextEncoder().encode(result.merged);
        await this.writeLocal(path, mergedBytes);
        const revisionId = crypto.randomUUID();
        await rest.putBlob(vaultId, revisionId, encryptContent(keys, mergedBytes));
        await rest.postRevision(vaultId, {
          id: revisionId,
          pathHmac: pathHmac(keys.macKey, path),
          encryptedPathB64: encryptPath(keys, path),
          parentIds: [remoteRevisionId],
          sizeBytes: mergedBytes.byteLength,
          clientMtime: new Date().toISOString(),
          deleted: false,
        } as Parameters<RestClient['postRevision']>[1]);
        const merged = vault.getFileByPath(path);
        this.updateIndexAfterSync(path, merged, mergedBytes, revisionId);
        this.opts.log(`merged ${path}`);
        return;
      }
    }
    await this.conflictFile(path, remoteBytes, remoteRevisionId);
  }

  /**
   * Overlapping edits or unmergeable content: remote wins the original path,
   * local becomes a conflict sibling (pushed as a new file on the next pass).
   */
  private async conflictFile(
    path: string,
    remoteBytes: Uint8Array,
    remoteRevisionId: string,
  ): Promise<void> {
    const { vault } = this.opts;
    const file = vault.getFileByPath(path);
    if (file) {
      const localBytes = new Uint8Array(await vault.readBinary(file));
      const conflictPath = this.conflictPathFor(path);
      await this.writeLocal(conflictPath, localBytes);
    }
    const remoteFile = await this.writeLocal(path, remoteBytes);
    this.updateIndexAfterSync(path, remoteFile, remoteBytes, remoteRevisionId);
    this.opts.log(`conflict on ${path} — local copy preserved as sibling`);
  }

  private conflictPathFor(path: string): string {
    const date = new Date().toISOString().slice(0, 10);
    const device = this.opts.deviceName || 'device';
    const dot = path.lastIndexOf('.');
    const stem = dot === -1 ? path : path.slice(0, dot);
    const ext = dot === -1 ? '' : path.slice(dot);
    let candidate = `${stem} (conflict ${date} ${device})${ext}`;
    let counter = 2;
    while (this.opts.vault.getFileByPath(obsidianNormalizePath(candidate))) {
      candidate = `${stem} (conflict ${date} ${device} ${counter})${ext}`;
      counter++;
    }
    return candidate;
  }

  /** Merge concurrent remote heads into one revision citing all of them. */
  private async mergeHeads(path: string, headIds: string[]): Promise<void> {
    const { keys, rest, vaultId, index } = this.opts;
    const base = index.get(path)?.basePlaintext;
    const texts: string[] = [];
    for (const id of headIds) {
      texts.push(new TextDecoder().decode(decryptContent(keys, await rest.getBlob(vaultId, id))));
    }

    let merged: string | null = null;
    if (isMergeableText(path) && base != null && texts.length === 2) {
      const result = threeWayMerge(base, texts[0]!, texts[1]!);
      if (result.ok) merged = result.merged;
    }

    if (merged == null) {
      // Unmergeable: newest head wins the path, every other head becomes a
      // conflict sibling. All revisions remain in history regardless.
      merged = texts[texts.length - 1]!;
      for (const text of texts.slice(0, -1)) {
        await this.writeLocal(this.conflictPathFor(path), new TextEncoder().encode(text));
      }
    }

    const mergedBytes = new TextEncoder().encode(merged);
    const revisionId = crypto.randomUUID();
    await rest.putBlob(vaultId, revisionId, encryptContent(keys, mergedBytes));
    await rest.postRevision(vaultId, {
      id: revisionId,
      pathHmac: pathHmac(keys.macKey, path),
      encryptedPathB64: encryptPath(keys, path),
      parentIds: headIds,
      sizeBytes: mergedBytes.byteLength,
      clientMtime: new Date().toISOString(),
      deleted: false,
    } as Parameters<RestClient['postRevision']>[1]);
    // Local file (and any local divergence) reconciles against the new single
    // head on the next pass.
    const file = await this.writeLocalIfUnchanged(path, mergedBytes);
    if (file) this.updateIndexAfterSync(path, file, mergedBytes, revisionId);
    this.opts.log(`merged ${headIds.length} concurrent heads of ${path}`);
  }

  // --- helpers -----------------------------------------------------------

  private async writeLocal(path: string, bytes: Uint8Array): Promise<TFile> {
    const { vault } = this.opts;
    const normalized = obsidianNormalizePath(path);
    this.applyingRemote = true;
    try {
      await this.ensureParentFolders(normalized);
      const existing = vault.getFileByPath(normalized);
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      if (existing) {
        await vault.modifyBinary(existing, buffer);
        return existing;
      }
      return await vault.createBinary(normalized, buffer);
    } finally {
      this.applyingRemote = false;
    }
  }

  private async writeLocalIfUnchanged(path: string, bytes: Uint8Array): Promise<TFile | null> {
    const idx = this.opts.index.get(path);
    const file = this.opts.vault.getFileByPath(path);
    const localChanged =
      file !== null && (!idx || file.stat.mtime !== idx.mtime || file.stat.size !== idx.size);
    if (localChanged) return null;
    return this.writeLocal(path, bytes);
  }

  private async ensureParentFolders(path: string): Promise<void> {
    const parts = path.split('/').slice(0, -1);
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

  private updateIndexAfterSync(
    path: string,
    file: TFile | null,
    plaintext: Uint8Array,
    revisionId: string,
  ): void {
    const cacheBase = isMergeableText(path) && plaintext.byteLength <= BASE_CACHE_MAX_BYTES;
    this.opts.index.set({
      path,
      mtime: file?.stat.mtime ?? Date.now(),
      size: file?.stat.size ?? plaintext.byteLength,
      lastSyncedRevisionId: revisionId,
      excluded: false,
      basePlaintext: cacheBase ? new TextDecoder().decode(plaintext) : null,
    });
  }
}
