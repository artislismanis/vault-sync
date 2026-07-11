import { normalizePath as obsidianNormalizePath, TFile, Vault } from 'obsidian';
import {
  VaultKeys,
  decryptContent,
  decryptPath,
  encryptPath,
  pathHmac,
  ItemHeads,
  Revision,
  CHUNK_BYTES,
  chunkCountFor,
  createStreamDecryptor,
  createStreamEncryptor,
  StreamDecryptionError,
} from '@vault-sync/shared';
import type { RestClient } from '../transport/rest';
import { IndexStore, isMergeableText, BASE_CACHE_MAX_BYTES } from './index-store';
import { planSync, Action, LocalFile, RemoteItem } from './planner';
import { ChunkSpool } from './spool';
import { threeWayMerge } from '../merge/diff3';

// Executes the planner's actions. Hard rule 4 discipline: every destructive
// local operation goes through vault.trash (recoverable), every push cites
// its parent (server history retains the prior version), and merge conflicts
// always produce a conflict file — never a silent discard.
//
// Memory discipline (blob format v2): content moves in 8 MiB secretstream
// chunks, so crypto + transport cost O(chunk). The whole-file plaintext
// buffer itself is unavoidable — Obsidian's vault API has no ranged reads —
// which is why the size cap exists.

const MAX_PASSES = 3;
const CHUNK_PUT_RETRIES = 3;
// Transfers above this are "large": their ciphertext chunks spool to disk for
// resume, and only one runs at a time regardless of the parallelism setting
// (bounds peak memory at roughly parallel × LARGE + one whole large file).
const LARGE_TRANSFER_BYTES = 32 * 1024 * 1024;

const yieldMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface EngineOptions {
  vault: Vault;
  rest: RestClient;
  keys: VaultKeys;
  vaultId: string;
  deviceName: string;
  index: IndexStore;
  /**
   * Selective-sync size cap in bytes; 0 = unlimited. A getter so settings
   * changes apply on the next sync without restarting the engine.
   */
  getMaxFileSizeBytes: () => number;
  /** Concurrent file transfers (1..6); large transfers self-serialize. */
  getParallelTransfers: () => number;
  /** Selective-sync category filter (live, from settings). */
  isCategoryExcluded: (path: string) => boolean;
  spool: ChunkSpool;
  log: (message: string) => void;
  notify: (message: string) => void;
  /** Live status line (status bar / progress toast); null clears it. */
  status: (message: string | null) => void;
}

export class SyncEngine {
  /** True while the engine itself writes files — vault-event handlers must ignore those. */
  applyingRemote = false;
  private running = false;
  private queued = false;
  private remoteHeadsByPath = new Map<string, ItemHeads>();

  constructor(private opts: EngineOptions) {}

  /**
   * Debounce-friendly entry point: coalesces overlapping requests.
   * Returns the number of actions executed (0 = already up to date).
   */
  async requestSync(): Promise<number> {
    if (this.running) {
      this.queued = true;
      return 0;
    }
    this.running = true;
    try {
      let total = 0;
      do {
        this.queued = false;
        total += await this.fullSync();
      } while (this.queued);
      return total;
    } finally {
      this.running = false;
      this.opts.status(null);
    }
  }

  async fullSync(): Promise<number> {
    const { log, status } = this.opts;
    let executed = 0;
    // Multiple passes: conflict files created in pass N are pushed in pass
    // N+1; a merge push also needs a follow-up heads check.
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      status('vault-sync: checking…');
      const actions = this.orderBySize(await this.planOnce());
      if (actions.length === 0) {
        if (pass === 0) log('sync: up to date');
        return executed;
      }
      log(`sync: pass ${pass + 1}, ${actions.length} action(s)`);

      // Instant actions (index/tombstone bookkeeping) first, then transfers
      // through the worker pool, then merges (order-sensitive) sequentially.
      const instant = actions.filter((a) => a.kind !== 'push' && a.kind !== 'pull' && a.kind !== 'merge' && a.kind !== 'mergeHeads');
      const transfers = actions.filter((a) => a.kind === 'push' || a.kind === 'pull');
      const merges = actions.filter((a) => a.kind === 'merge' || a.kind === 'mergeHeads');

      for (const action of instant) {
        await this.execute(action);
        executed++;
      }
      executed += await this.runTransferPool(transfers);
      for (const action of merges) {
        status(`vault-sync: merging ${action.path}`);
        await this.execute(action);
        executed++;
      }
      await this.opts.index.persist();
    }
    return executed;
  }

  /**
   * Concurrent transfers with two guarantees: small files are never starved
   * by big ones (queue is size-ordered), and at most ONE large transfer is in
   * flight (whole-file buffers must not stack up on mobile).
   */
  private async runTransferPool(transfers: Action[]): Promise<number> {
    if (transfers.length === 0) return 0;
    const limit = Math.min(Math.max(1, this.opts.getParallelTransfers()), 6, transfers.length);
    let next = 0;
    let done = 0;
    let largeLock: Promise<void> = Promise.resolve();
    const errors: unknown[] = [];

    const worker = async () => {
      for (;;) {
        const action = transfers[next++];
        if (!action) return;
        try {
          if (this.sizeOf(action) > LARGE_TRANSFER_BYTES) {
            const previous = largeLock;
            let release!: () => void;
            largeLock = new Promise((resolve) => (release = resolve));
            await previous;
            try {
              await this.execute(action);
            } finally {
              release();
            }
          } else {
            await this.execute(action);
          }
          done++;
          this.opts.status(`vault-sync: ${done}/${transfers.length} file(s)`);
        } catch (err) {
          errors.push(err);
        }
      }
    };

    await Promise.all(Array.from({ length: limit }, worker));
    if (errors.length > 0) {
      // Completed transfers are already indexed; the rest retry next sync.
      throw errors[0];
    }
    return done;
  }

  /**
   * Small files first: a 500 MB transfer must never make a one-line note
   * edit wait minutes. Metadata-only actions sort to the front.
   */
  private orderBySize(actions: Action[]): Action[] {
    return [...actions].sort((a, b) => this.sizeOf(a) - this.sizeOf(b));
  }

  private sizeOf(action: Action): number {
    switch (action.kind) {
      case 'push':
        return this.opts.vault.getFileByPath(action.path)?.stat.size ?? 0;
      case 'pull':
      case 'merge':
      case 'mergeHeads': {
        const heads = this.remoteHeadsByPath.get(action.path)?.heads ?? [];
        return Math.max(0, ...heads.map((h) => h.sizeBytes));
      }
      default:
        return 0; // tombstones, exclusions, index cleanup — instant
    }
  }

  private async planOnce(): Promise<Action[]> {
    const local = this.scanLocal();
    const remote = await this.fetchRemote();
    // Spools for revisions that are no longer heads can never complete.
    const headIds = new Set<string>();
    for (const item of this.remoteHeadsByPath.values()) {
      for (const head of item.heads) headIds.add(head.id);
    }
    await this.opts.spool.retainOnly(headIds);
    return planSync({
      local,
      index: this.opts.index.all(),
      remote,
      maxFileSizeBytes: this.opts.getMaxFileSizeBytes(),
      isCategoryExcluded: this.opts.isCategoryExcluded,
    });
  }

  // --- version history -----------------------------------------------------

  /** Newest-first revision list for a path (throws if never synced). */
  async getHistory(path: string): Promise<Revision[]> {
    const response = await this.opts.rest.history(
      this.opts.vaultId,
      pathHmac(this.opts.keys.macKey, path),
    );
    return response.revisions;
  }

  /**
   * Restore: write the old revision's content locally, then sync — it pushes
   * as a NEW revision citing the current head. Nothing is ever rewritten;
   * the pre-restore state stays one step back in history.
   */
  async restoreRevision(path: string, revision: Revision): Promise<void> {
    const bytes = await this.readBlob(revision);
    await this.writeLocal(path, bytes);
    this.opts.log(`restored ${path} from revision of ${revision.serverReceivedAt}`);
    await this.requestSync();
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

  private async fetchRemote(): Promise<RemoteItem[]> {
    const response = await this.opts.rest.heads(this.opts.vaultId);
    this.remoteHeadsByPath.clear();
    const remote: RemoteItem[] = [];
    for (const item of response.items) {
      const path = decryptPath(this.opts.keys, item.encryptedPathB64);
      this.remoteHeadsByPath.set(path, item);
      remote.push({
        path,
        heads: item.heads.map((h) => ({
          revisionId: h.id,
          deleted: h.deleted,
          sizeBytes: h.sizeBytes,
        })),
      });
    }
    return remote;
  }

  private findHead(path: string, revisionId: string): Revision {
    const head = this.remoteHeadsByPath.get(path)?.heads.find((h) => h.id === revisionId);
    if (!head) throw new Error(`head ${revisionId} for ${path} vanished mid-sync`);
    return head;
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
      case 'exclude':
        return this.exclude(action.path, action.reason);
      case 'forgetIndex':
        this.opts.index.remove(action.path);
        return;
    }
  }

  // --- blob I/O (format v2 chunked; v1 legacy read) ------------------------

  /**
   * Chunked upload: encrypt+PUT one 8 MiB chunk at a time, dropping each
   * ciphertext once acknowledged. Retries re-send the SAME ciphertext — the
   * secretstream ratchet must never run twice for one chunk.
   */
  private async uploadContent(
    path: string,
    plaintext: Uint8Array,
    parentIds: string[],
    clientMtime: string,
  ): Promise<string> {
    const { rest, keys, vaultId } = this.opts;
    const revisionId = crypto.randomUUID();
    const encryptor = createStreamEncryptor(keys.contentKey, revisionId);
    const chunks = chunkCountFor(plaintext.byteLength);

    for (let seq = 0; seq < chunks; seq++) {
      if (chunks > 4) {
        this.opts.status(`vault-sync: uploading ${path} — chunk ${seq + 1}/${chunks}`);
      }
      const slice = plaintext.subarray(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES);
      // Loop-scoped so each ciphertext is collectible after its PUT succeeds.
      const ciphertext = encryptor.pushChunk(slice, seq === chunks - 1);
      let lastError: unknown;
      let sent = false;
      for (let attempt = 0; attempt < CHUNK_PUT_RETRIES && !sent; attempt++) {
        try {
          if (attempt > 0) await sleep(1000 * attempt);
          await rest.putChunk(vaultId, revisionId, seq, ciphertext);
          sent = true;
        } catch (err) {
          lastError = err;
        }
      }
      if (!sent) throw lastError;
      await yieldMain();
    }

    await rest.postRevision(vaultId, {
      id: revisionId,
      pathHmac: pathHmac(keys.macKey, path),
      encryptedPathB64: encryptPath(keys, path),
      parentIds,
      sizeBytes: plaintext.byteLength,
      clientMtime,
      deleted: false,
      chunks,
      streamHeaderB64: encryptor.headerB64,
    } as Parameters<RestClient['postRevision']>[1]);
    return revisionId;
  }

  /** Format-dispatched download: v2 chunked (preallocated) or legacy v1. */
  private async readBlob(revision: Revision): Promise<Uint8Array> {
    const { rest, keys, vaultId, spool } = this.opts;
    if (revision.chunks == null || revision.streamHeaderB64 == null) {
      return decryptContent(keys, await rest.getBlob(vaultId, revision.id));
    }

    // Large downloads are resumable: ciphertext chunks spool to disk as they
    // arrive (an interrupted pull re-fetches only what's missing), and the
    // whole-file plaintext buffer exists only during recompose below.
    const useSpool = revision.sizeBytes > LARGE_TRANSFER_BYTES;
    if (useSpool) {
      for (let seq = 0; seq < revision.chunks; seq++) {
        if (await spool.has(revision.id, seq)) continue;
        this.opts.status(`vault-sync: downloading — chunk ${seq + 1}/${revision.chunks}`);
        await spool.write(revision.id, seq, await rest.getChunk(vaultId, revision.id, seq));
        await yieldMain();
      }
      this.opts.status('vault-sync: recomposing…');
    }

    const decryptor = createStreamDecryptor(keys.contentKey, revision.id, revision.streamHeaderB64);
    // One exact-size buffer; each decrypted chunk is copied in and dropped.
    const out = new Uint8Array(revision.sizeBytes);
    let offset = 0;
    try {
      for (let seq = 0; seq < revision.chunks; seq++) {
        const ciphertext = useSpool
          ? await spool.read(revision.id, seq)
          : await rest.getChunk(vaultId, revision.id, seq);
        const { plaintext, final } = decryptor.pullChunk(ciphertext);
        if (final !== (seq === revision.chunks - 1)) {
          throw new StreamDecryptionError('stream length mismatch (truncated or extended)');
        }
        if (offset + plaintext.byteLength > out.byteLength) {
          throw new StreamDecryptionError('content larger than declared size');
        }
        out.set(plaintext, offset);
        offset += plaintext.byteLength;
        await yieldMain();
      }
      if (offset !== out.byteLength) {
        throw new StreamDecryptionError('content smaller than declared size');
      }
    } catch (err) {
      // A spool that fails authentication is corrupt — never resume from it.
      if (useSpool && err instanceof StreamDecryptionError) await spool.clear(revision.id);
      throw err;
    }
    if (useSpool) await spool.clear(revision.id);
    return out;
  }

  // --- push side ---------------------------------------------------------

  private async push(path: string, parentIds: string[]): Promise<void> {
    const { vault } = this.opts;
    const file = vault.getFileByPath(path);
    if (!file) return; // vanished between scan and execution; next pass handles it
    const plaintext = new Uint8Array(await vault.readBinary(file));
    const revisionId = await this.uploadContent(
      path,
      plaintext,
      parentIds,
      new Date(file.stat.mtime).toISOString(),
    );
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
    const plaintext = await this.readBlob(this.findHead(path, revisionId));
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

  private exclude(path: string, reason: 'size' | 'category'): void {
    const local = this.opts.vault.getFileByPath(path);
    this.opts.index.set({
      path,
      mtime: local?.stat.mtime ?? 0,
      size: local?.stat.size ?? 0,
      lastSyncedRevisionId: null,
      excluded: true,
      basePlaintext: null,
    });
    if (reason === 'size') {
      const capMb = Math.round(this.opts.getMaxFileSizeBytes() / (1024 * 1024));
      this.opts.notify(`vault-sync: "${path}" exceeds the ${capMb} MB size cap — not synced`);
    }
    // Category exclusions are a chosen setting — log only, no toast spam.
    this.opts.log(`excluded ${path} (${reason})`);
  }

  // --- merge side --------------------------------------------------------

  private async merge(path: string, remoteRevisionId: string): Promise<void> {
    const { vault, index } = this.opts;
    const file = vault.getFileByPath(path);
    if (!file) return;
    const remoteBytes = await this.readBlob(this.findHead(path, remoteRevisionId));
    const base = index.get(path)?.basePlaintext;

    if (isMergeableText(path) && base != null) {
      const localText = new TextDecoder().decode(new Uint8Array(await vault.readBinary(file)));
      const remoteText = new TextDecoder().decode(remoteBytes);
      const result = threeWayMerge(base, localText, remoteText);
      if (result.ok) {
        const mergedBytes = new TextEncoder().encode(result.merged);
        await this.writeLocal(path, mergedBytes);
        const revisionId = await this.uploadContent(
          path,
          mergedBytes,
          [remoteRevisionId],
          new Date().toISOString(),
        );
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
    const { index } = this.opts;
    const base = index.get(path)?.basePlaintext;
    const texts: string[] = [];
    for (const id of headIds) {
      texts.push(new TextDecoder().decode(await this.readBlob(this.findHead(path, id))));
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
    const revisionId = await this.uploadContent(path, mergedBytes, headIds, new Date().toISOString());
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
      // Avoid a full copy when the view already spans its whole buffer
      // (always true for readBlob output — this matters at 500 MB).
      const spansBuffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
      const buffer = spansBuffer
        ? (bytes.buffer as ArrayBuffer)
        : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
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
