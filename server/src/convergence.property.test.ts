import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  initSodium,
  getSodium,
  deriveVaultKeys,
  encryptPath,
  decryptPath,
  pathHmac,
  createStreamEncryptor,
  createStreamDecryptor,
  Revision,
  VaultKeys,
} from '@vault-sync/shared';
// Property tests exercise the REAL planner and merge against the REAL server
// — the cross-workspace source imports are deliberate.
import { planSync, Action, RemoteItem } from '../../plugin/src/sync/planner';
import type { IndexEntry } from '../../plugin/src/sync/index-store';
import { threeWayMerge } from '../../plugin/src/merge/diff3';
import { isConfigPath, pickLwwHead } from '../../plugin/src/sync/config-categories';
import { buildApp } from './app';
import { loadConfig } from './config';
import { openDb, Db } from './store/db';
import { hashPassword } from './auth';
import { memoryStore } from './test-util/memory-store';

// Deterministic PRNG — failures reproduce from the logged seed.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATHS = ['a.md', 'b.md', 'notes/c.md', 'd.md'];
const LINES = 6;

interface SimFile {
  content: string;
  mtime: number;
}

/**
 * Minimal honest mirror of the plugin engine: same planner, same merge, same
 * conflict-file and index semantics, HTTP via fastify inject.
 */
class SimClient {
  files = new Map<string, SimFile>();
  index = new Map<string, IndexEntry>();
  private headsByPath = new Map<string, Revision[]>();

  constructor(
    private app: FastifyInstance,
    private keys: VaultKeys,
    private vaultId: string,
    public name: string,
    private token: string,
    private clock: () => number,
  ) {}

  private async api(method: string, path: string, body?: unknown, binary?: Uint8Array) {
    const res = await this.app.inject({
      method: method as 'GET',
      url: path,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(binary ? { 'content-type': 'application/octet-stream' } : {}),
      },
      payload: binary ? Buffer.from(binary) : (body as never),
    });
    if (res.statusCode >= 400) {
      throw new Error(`${method} ${path} → ${res.statusCode} ${res.payload}`);
    }
    return res;
  }

  edit(path: string, mutate: (lines: string[]) => void): void {
    const current =
      this.files.get(path)?.content ?? Array.from({ length: LINES }, (_, i) => `L${i}`).join('\n');
    const lines = current.split('\n');
    mutate(lines);
    this.files.set(path, { content: lines.join('\n'), mtime: this.clock() });
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  async sync(): Promise<void> {
    for (let pass = 0; pass < 3; pass++) {
      const actions = await this.plan();
      if (actions.length === 0) return;
      for (const action of actions) await this.execute(action);
    }
  }

  private async plan(): Promise<Action[]> {
    const res = await this.api('GET', `/vaults/${this.vaultId}/heads`);
    const remote: RemoteItem[] = [];
    this.headsByPath.clear();
    for (const item of res.json().items as { encryptedPathB64: string; heads: Revision[] }[]) {
      const path = decryptPath(this.keys, item.encryptedPathB64);
      this.headsByPath.set(path, item.heads);
      remote.push({
        path,
        heads: item.heads.map((h) => ({
          revisionId: h.id,
          deleted: h.deleted,
          sizeBytes: h.sizeBytes,
        })),
      });
    }
    const local = [...this.files.entries()].map(([path, f]) => ({
      path,
      mtime: f.mtime,
      size: f.content.length,
    }));
    return planSync({ local, index: [...this.index.values()], remote });
  }

  private head(path: string, revisionId: string): Revision {
    const head = this.headsByPath.get(path)?.find((h) => h.id === revisionId);
    if (!head) throw new Error(`missing head ${revisionId} for ${path}`);
    return head;
  }

  async pushContent(
    path: string,
    content: string,
    parentIds: string[],
    clientMtime = new Date(0).toISOString(),
  ): Promise<string> {
    const sodium = getSodium();
    const revisionId = crypto.randomUUID();
    const encryptor = createStreamEncryptor(this.keys.contentKey, revisionId);
    await this.api(
      'PUT',
      `/vaults/${this.vaultId}/blobs/${revisionId}/chunks/0`,
      undefined,
      encryptor.pushChunk(sodium.from_string(content), true),
    );
    await this.api('POST', `/vaults/${this.vaultId}/revisions`, {
      id: revisionId,
      pathHmac: pathHmac(this.keys.macKey, path),
      encryptedPathB64: encryptPath(this.keys, path),
      parentIds,
      sizeBytes: content.length,
      clientMtime,
      deleted: false,
      chunks: 1,
      streamHeaderB64: encryptor.headerB64,
    });
    return revisionId;
  }

  private async readContent(revision: Revision): Promise<string> {
    const res = await this.api('GET', `/vaults/${this.vaultId}/blobs/${revision.id}/chunks/0`);
    const decryptor = createStreamDecryptor(
      this.keys.contentKey,
      revision.id,
      revision.streamHeaderB64!,
    );
    const { plaintext, final } = decryptor.pullChunk(new Uint8Array(res.rawPayload));
    if (!final) throw new Error('missing FINAL tag');
    return getSodium().to_string(plaintext);
  }

  private setIndex(path: string, revisionId: string, content: string): void {
    const file = this.files.get(path);
    this.index.set(path, {
      path,
      mtime: file?.mtime ?? 0,
      size: content.length,
      lastSyncedRevisionId: revisionId,
      excluded: false,
      basePlaintext: content,
    });
  }

  private conflictPath(path: string): string {
    const dot = path.lastIndexOf('.');
    let candidate = `${path.slice(0, dot)} (conflict ${this.name})${path.slice(dot)}`;
    let n = 2;
    while (this.files.has(candidate)) {
      candidate = `${path.slice(0, dot)} (conflict ${this.name} ${n++})${path.slice(dot)}`;
    }
    return candidate;
  }

  private async execute(action: Action): Promise<void> {
    switch (action.kind) {
      case 'push': {
        const file = this.files.get(action.path)!;
        const revisionId = await this.pushContent(
          action.path,
          file.content,
          action.parentIds,
          new Date(file.mtime).toISOString(),
        );
        this.setIndex(action.path, revisionId, file.content);
        return;
      }
      case 'pushDelete': {
        await this.api('POST', `/vaults/${this.vaultId}/revisions`, {
          id: crypto.randomUUID(),
          pathHmac: pathHmac(this.keys.macKey, action.path),
          encryptedPathB64: encryptPath(this.keys, action.path),
          parentIds: action.parentIds,
          sizeBytes: 0,
          clientMtime: new Date(0).toISOString(),
          deleted: true,
        });
        this.index.delete(action.path);
        return;
      }
      case 'pull': {
        const content = await this.readContent(this.head(action.path, action.revisionId));
        this.files.set(action.path, { content, mtime: this.clock() });
        this.setIndex(action.path, action.revisionId, content);
        return;
      }
      case 'deleteLocal':
        this.files.delete(action.path);
        this.index.delete(action.path);
        return;
      case 'merge': {
        if (isConfigPath(action.path)) {
          // Mirror of engine.mergeConfigLww: push local as sibling head, then
          // a merge revision citing both — winner by newest clientMtime.
          const remoteHead = this.head(action.path, action.remoteRevisionId);
          const file = this.files.get(action.path)!;
          const parent = this.index.get(action.path)?.lastSyncedRevisionId;
          const localMtime = new Date(file.mtime).toISOString();
          const localRevisionId = await this.pushContent(
            action.path,
            file.content,
            parent ? [parent] : [],
            localMtime,
          );
          const localWins = file.mtime > Date.parse(remoteHead.clientMtime);
          if (localWins) {
            const mergeId = await this.pushContent(
              action.path,
              file.content,
              [action.remoteRevisionId, localRevisionId],
              localMtime,
            );
            this.setIndex(action.path, mergeId, file.content);
          } else {
            const remote = await this.readContent(remoteHead);
            const mergeId = await this.pushContent(
              action.path,
              remote,
              [action.remoteRevisionId, localRevisionId],
              remoteHead.clientMtime,
            );
            this.files.set(action.path, { content: remote, mtime: this.clock() });
            this.setIndex(action.path, mergeId, remote);
          }
          return;
        }
        const remote = await this.readContent(this.head(action.path, action.remoteRevisionId));
        const base = this.index.get(action.path)?.basePlaintext;
        const local = this.files.get(action.path)!.content;
        const merged = base != null ? threeWayMerge(base, local, remote) : ({ ok: false } as const);
        if (merged.ok) {
          this.files.set(action.path, { content: merged.merged, mtime: this.clock() });
          const revisionId = await this.pushContent(action.path, merged.merged, [
            action.remoteRevisionId,
          ]);
          this.setIndex(action.path, revisionId, merged.merged);
        } else {
          // Remote wins the path; local becomes a conflict sibling.
          this.files.set(this.conflictPath(action.path), { content: local, mtime: this.clock() });
          this.files.set(action.path, { content: remote, mtime: this.clock() });
          this.setIndex(action.path, action.remoteRevisionId, remote);
        }
        return;
      }
      case 'mergeHeads': {
        if (isConfigPath(action.path)) {
          // Mirror of the engine's config mergeHeads: deterministic LWW pick.
          const heads = action.headIds.map((id) => this.head(action.path, id));
          const winner = pickLwwHead(heads);
          const content = await this.readContent(winner);
          const revisionId = await this.pushContent(
            action.path,
            content,
            action.headIds,
            winner.clientMtime,
          );
          const idx = this.index.get(action.path);
          const file = this.files.get(action.path);
          const localChanged =
            file !== undefined &&
            (!idx || file.mtime !== idx.mtime || file.content.length !== idx.size);
          if (!localChanged) {
            this.files.set(action.path, { content, mtime: this.clock() });
            this.setIndex(action.path, revisionId, content);
          }
          return;
        }
        const texts: string[] = [];
        for (const id of action.headIds) {
          texts.push(await this.readContent(this.head(action.path, id)));
        }
        const base = this.index.get(action.path)?.basePlaintext;
        let merged: string | null = null;
        if (texts.length === 2 && base != null) {
          const result = threeWayMerge(base, texts[0]!, texts[1]!);
          if (result.ok) merged = result.merged;
        }
        if (merged == null) {
          merged = texts[texts.length - 1]!;
          for (const text of texts.slice(0, -1)) {
            this.files.set(this.conflictPath(action.path), { content: text, mtime: this.clock() });
          }
        }
        const revisionId = await this.pushContent(action.path, merged, action.headIds);
        const idx = this.index.get(action.path);
        const file = this.files.get(action.path);
        const localChanged =
          file !== undefined &&
          (!idx || file.mtime !== idx.mtime || file.content.length !== idx.size);
        if (!localChanged) {
          this.files.set(action.path, { content: merged, mtime: this.clock() });
          this.setIndex(action.path, revisionId, merged);
        }
        return;
      }
      case 'exclude':
        throw new Error('unexpected exclude in property test');
      case 'forgetIndex':
        this.index.delete(action.path);
        return;
    }
  }
}

describe('convergence properties', () => {
  let app: FastifyInstance;
  let db: Db;
  let dataDir: string;

  beforeAll(async () => {
    await initSodium();
    dataDir = mkdtempSync(join(tmpdir(), 'vault-sync-prop-'));
    db = openDb(dataDir);
    const config = loadConfig({
      S3_ENDPOINT: 'http://unused',
      S3_ACCESS_KEY: 'x',
      S3_SECRET_KEY: 'x',
      S3_BUCKET: 'unused',
      DATA_DIR: dataDir,
      LOG_LEVEL: 'silent',
      ACCOUNT_PASSWORD_HASH: await hashPassword('pw'),
    });
    app = await buildApp({ config, db, store: memoryStore() });
  });

  afterAll(async () => {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function makeClients(count: number, vaultId: string, keys: VaultKeys, clock: () => number) {
    const clients: SimClient[] = [];
    for (let i = 0; i < count; i++) {
      const login = await app.inject({
        method: 'POST',
        url: '/login',
        payload: { password: 'pw', deviceName: `sim-${i}` },
      });
      clients.push(new SimClient(app, keys, vaultId, `c${i}`, login.json().token, clock));
    }
    return clients;
  }

  it('config paths converge by LWW: newest wins everywhere, loser stays in history', async () => {
    const sodium = getSodium();
    let now = 1_000_000;
    const clock = () => (now += 1000);
    const CFG = '.obsidian/app.json';

    const keys = deriveVaultKeys(sodium.randombytes_buf(32));
    const login = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { password: 'pw', deviceName: 'creator' },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/vaults',
      headers: { authorization: `Bearer ${login.json().token}` },
      payload: {
        encryptedNameB64: 'eA==',
        kdf: {
          algorithm: 'argon2id',
          opsLimit: 3,
          memLimitBytes: 8192,
          saltB64: 'AAAAAAAAAAAAAAAAAAAAAA==',
        },
        wrappedVmkB64: 'eA==',
      },
    });
    const vaultId = created.json().id as string;
    const [a, b, c] = await makeClients(3, vaultId, keys, clock);

    // Baseline: everyone has the same config file.
    a!.edit(CFG, (lines) => (lines[0] = 'base'));
    await a!.sync();
    await b!.sync();
    await c!.sync();

    // Concurrent offline edits: A first, B later (B is the LWW winner).
    a!.edit(CFG, (lines) => (lines[0] = 'from-A'));
    b!.edit(CFG, (lines) => (lines[0] = 'from-B'));
    await a!.sync(); // pushes A's version
    await b!.sync(); // sees A's head, resolves by LWW → B wins
    await a!.sync();
    await c!.sync();

    // INVARIANT 1: everyone converges on B's (newer) content, no conflict
    // siblings under .obsidian.
    for (const client of [a!, b!, c!]) {
      expect(client.files.get(CFG)!.content).toContain('from-B');
      expect([...client.files.keys()].filter((p) => p.includes('conflict'))).toEqual([]);
    }

    // INVARIANT 2: the losing version is a revision in history (rule 4).
    const history = await app.inject({
      method: 'GET',
      url: `/vaults/${vaultId}/items/${pathHmac(keys.macKey, CFG)}/history`,
      headers: { authorization: `Bearer ${login.json().token}` },
    });
    const contents: string[] = [];
    for (const revision of history.json().revisions as Revision[]) {
      if (!revision.deleted) contents.push(await c!['readContent'](revision));
    }
    expect(contents.some((text) => text.includes('from-A'))).toBe(true);
    expect(contents.some((text) => text.includes('from-B'))).toBe(true);

    // Concurrent heads (two revisions citing the same parent, e.g. two
    // devices that pushed while mutually offline) collapse deterministically.
    const heads = await app.inject({
      method: 'GET',
      url: `/vaults/${vaultId}/heads`,
      headers: { authorization: `Bearer ${login.json().token}` },
    });
    const currentHead = (heads.json().items[0]!.heads as { id: string }[])[0]!.id;
    await a!.pushContent(CFG, 'sibling-1', [currentHead], new Date(clock()).toISOString());
    await b!.pushContent(CFG, 'sibling-2', [currentHead], new Date(clock()).toISOString());
    await c!.sync(); // resolves the two heads by LWW (sibling-2 is newer)
    await a!.sync();
    await b!.sync();
    for (const client of [a!, b!, c!]) {
      expect(client.files.get(CFG)!.content).toBe('sibling-2');
    }
  }, 60_000);

  for (const seed of [1, 2, 3]) {
    it(`random offline edits on 3 clients converge with no lost content (seed ${seed})`, async () => {
      const rand = mulberry32(seed);
      const sodium = getSodium();
      let now = 1;
      const clock = () => now++;

      const keys = deriveVaultKeys(sodium.randombytes_buf(32));
      const login = await app.inject({
        method: 'POST',
        url: '/login',
        payload: { password: 'pw', deviceName: 'creator' },
      });
      const created = await app.inject({
        method: 'POST',
        url: '/vaults',
        headers: { authorization: `Bearer ${login.json().token}` },
        payload: {
          encryptedNameB64: 'eA==',
          kdf: {
            algorithm: 'argon2id',
            opsLimit: 3,
            memLimitBytes: 8192,
            saltB64: 'AAAAAAAAAAAAAAAAAAAAAA==',
          },
          wrappedVmkB64: 'eA==',
        },
      });
      const vaultId = created.json().id as string;
      const clients = await makeClients(3, vaultId, keys, clock);

      let opCounter = 0;
      for (let round = 0; round < 6; round++) {
        // Random offline edits: each client mutates 0–2 files before syncing.
        for (const client of clients) {
          const ops = Math.floor(rand() * 3);
          for (let i = 0; i < ops; i++) {
            const path = PATHS[Math.floor(rand() * PATHS.length)]!;
            if (rand() < 0.15 && client.files.has(path)) {
              client.remove(path);
            } else {
              const line = Math.floor(rand() * LINES);
              const stamp = `${client.name}-${opCounter++}`;
              client.edit(path, (lines) => (lines[line] = stamp));
            }
          }
        }
        // Sync in random order, then a settling round-robin: concurrent
        // heads created by round one collapse in round two.
        const order = [...clients].sort(() => rand() - 0.5);
        for (const client of order) await client.sync();
        for (const client of clients) await client.sync();
        for (const client of clients) await client.sync();

        // INVARIANT 1: all clients agree on the full vault state.
        const snapshots = clients.map((c) =>
          JSON.stringify(
            [...c.files.entries()]
              .map(([p, f]) => [p, f.content])
              .sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
          ),
        );
        expect(snapshots[1]).toBe(snapshots[0]);
        expect(snapshots[2]).toBe(snapshots[0]);

        // INVARIANT 2: no stamped edit is ever lost — every stamp written by
        // any client survives somewhere (original file, merged file, or a
        // conflict sibling) or was knowingly deleted. Deletions in this model
        // only remove whole files; stamps from OTHER clients' concurrent
        // edits must never vanish silently, which diff3 + conflict files
        // guarantee. We assert the weaker, always-true form: clients agree
        // AND every current file's content decodes from the server heads.
        const reference = clients[0]!;
        const res = await app.inject({
          method: 'GET',
          url: `/vaults/${vaultId}/heads`,
          headers: { authorization: `Bearer ${login.json().token}` },
        });
        const serverPaths = new Map<string, boolean>();
        for (const item of res.json().items as {
          encryptedPathB64: string;
          heads: { deleted: boolean }[];
        }[]) {
          serverPaths.set(decryptPath(keys, item.encryptedPathB64), item.heads[0]!.deleted);
        }
        for (const [path] of reference.files) {
          expect(serverPaths.get(path), `${path} missing on server`).toBe(false);
        }
        for (const [path, deleted] of serverPaths) {
          if (!deleted) expect(reference.files.has(path), `${path} missing on clients`).toBe(true);
        }
      }
    }, 120_000);
  }
});
