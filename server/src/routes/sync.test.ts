import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { openDb, Db } from '../store/db';
import type { ObjectStore } from '../store/s3';
import { rebuildIndex } from '../store/metadata-log';
import { hashPassword } from '../auth';

function memoryStore(): ObjectStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const toBytes = (body: Uint8Array | string) =>
    typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    objects,
    async checkBucket() {
      return true;
    },
    async put(key, body) {
      objects.set(key, toBytes(body));
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) throw new Error(`no such key: ${key}`);
      return value;
    },
    async getStream(key) {
      const value = objects.get(key);
      if (!value) throw new Error(`no such key: ${key}`);
      return Readable.from(Buffer.from(value));
    },
    async exists(key) {
      return objects.has(key);
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    async listWithMeta(prefix) {
      return [...objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .map((key) => ({ key, lastModified: new Date() }));
    },
  };
}

const KDF = {
  algorithm: 'argon2id',
  opsLimit: 3,
  memLimitBytes: 67108864,
  saltB64: 'AAAAAAAAAAAAAAAAAAAAAA==',
};

describe('sync routes', () => {
  let app: FastifyInstance;
  let db: Db;
  let dataDir: string;
  let store: ReturnType<typeof memoryStore>;
  let token: string;
  let vaultId: string;

  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'vault-sync-test-'));
    db = openDb(dataDir);
    store = memoryStore();
    const config = loadConfig({
      S3_ENDPOINT: 'http://unused',
      S3_ACCESS_KEY: 'x',
      S3_SECRET_KEY: 'x',
      S3_BUCKET: 'unused',
      DATA_DIR: dataDir,
      LOG_LEVEL: 'silent',
      ACCOUNT_PASSWORD_HASH: await hashPassword('correct-password'),
    });
    app = await buildApp({ config, db, store });
  });

  afterAll(async () => {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports the server version at /healthz (no auth required)', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      s3: 'ok',
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    });
  });

  it('rejects wrong password and unauthenticated requests', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { password: 'wrong', deviceName: 'test' },
    });
    expect(bad.statusCode).toBe(401);
    const noAuth = await app.inject({ method: 'GET', url: '/vaults' });
    expect(noAuth.statusCode).toBe(401);
  });

  it('logs in and creates a vault', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { password: 'correct-password', deviceName: 'test-device' },
    });
    expect(login.statusCode).toBe(200);
    token = login.json().token;

    const created = await app.inject({
      method: 'POST',
      url: '/vaults',
      headers: auth(),
      payload: { encryptedNameB64: 'b3BhcXVl', kdf: KDF, wrappedVmkB64: 'b3BhcXVl' },
    });
    expect(created.statusCode).toBe(201);
    vaultId = created.json().id;
  });

  const rev = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const HMAC = 'a'.repeat(64);

  async function putChunk(id: string, seq: number, payload = `ciphertext-${id}-${seq}`) {
    return app.inject({
      method: 'PUT',
      url: `/vaults/${vaultId}/blobs/${id}/chunks/${seq}`,
      headers: { ...auth(), 'content-type': 'application/octet-stream' },
      payload: Buffer.from(payload),
    });
  }

  async function pushRevision(
    id: string,
    parentIds: string[],
    deleted = false,
    options: { chunks?: number; skipUpload?: boolean } = {},
  ) {
    const chunks = options.chunks ?? 1;
    if (!deleted && !options.skipUpload) {
      for (let seq = 0; seq < chunks; seq++) {
        expect((await putChunk(id, seq)).statusCode).toBe(204);
      }
    }
    return app.inject({
      method: 'POST',
      url: `/vaults/${vaultId}/revisions`,
      headers: auth(),
      payload: {
        id,
        pathHmac: HMAC,
        encryptedPathB64: 'cGF0aA==',
        parentIds,
        sizeBytes: deleted ? 0 : 16,
        clientMtime: '2026-07-11T10:00:00.000Z',
        deleted,
        ...(deleted ? {} : { chunks, streamHeaderB64: 'aGVhZGVy' }),
      },
    });
  }

  async function heads() {
    const res = await app.inject({ method: 'GET', url: `/vaults/${vaultId}/heads`, headers: auth() });
    expect(res.statusCode).toBe(200);
    return res.json().items as {
      itemId: string;
      heads: { id: string; deleted: boolean }[];
    }[];
  }

  it('rejects incomplete or malformed chunked pushes', async () => {
    // Declared 2 chunks, uploaded 0.
    const missing = await pushRevision(rev(9), [], false, { chunks: 2, skipUpload: true });
    expect(missing.statusCode).toBe(400);
    // Declared 1 chunk but uploaded 2 (stray key).
    await putChunk(rev(9), 0);
    await putChunk(rev(9), 1);
    const stray = await pushRevision(rev(9), [], false, { chunks: 1, skipUpload: true });
    expect(stray.statusCode).toBe(400);
    expect(stray.json().error).toMatch(/stray/);
    // Legacy (unchunked) non-deleted push is no longer accepted.
    const legacy = await app.inject({
      method: 'POST',
      url: `/vaults/${vaultId}/revisions`,
      headers: auth(),
      payload: {
        id: rev(8),
        pathHmac: HMAC,
        encryptedPathB64: 'cGF0aA==',
        parentIds: [],
        sizeBytes: 16,
        clientMtime: '2026-07-11T10:00:00.000Z',
        deleted: false,
      },
    });
    expect(legacy.statusCode).toBe(400);
    expect(legacy.json().error).toMatch(/chunked upload required/);
  });

  it('pushes chunked revisions, advances the head, and serves chunks back', async () => {
    const first = await pushRevision(rev(1), [], false, { chunks: 2 });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ chunks: 2, streamHeaderB64: 'aGVhZGVy' });
    let items = await heads();
    expect(items).toHaveLength(1);
    expect(items[0]!.heads.map((h) => h.id)).toEqual([rev(1)]);

    expect((await pushRevision(rev(2), [rev(1)])).statusCode).toBe(201);
    items = await heads();
    expect(items[0]!.heads.map((h) => h.id)).toEqual([rev(2)]);

    const chunk = await app.inject({
      method: 'GET',
      url: `/vaults/${vaultId}/blobs/${rev(1)}/chunks/1`,
      headers: auth(),
    });
    expect(chunk.statusCode).toBe(200);
    expect(chunk.rawPayload.toString()).toBe(`ciphertext-${rev(1)}-1`);
    // Out-of-range chunk 404s.
    const outOfRange = await app.inject({
      method: 'GET',
      url: `/vaults/${vaultId}/blobs/${rev(2)}/chunks/1`,
      headers: auth(),
    });
    expect(outOfRange.statusCode).toBe(404);
  });

  it('represents concurrent pushes as multiple heads, resolved by a merge revision', async () => {
    // Second device pushes concurrently: same parent as rev(2).
    expect((await pushRevision(rev(3), [rev(1)])).statusCode).toBe(201);
    let items = await heads();
    expect(items[0]!.heads.map((h) => h.id).sort()).toEqual([rev(2), rev(3)]);

    // Client merges and cites both parents.
    expect((await pushRevision(rev(4), [rev(2), rev(3)])).statusCode).toBe(201);
    items = await heads();
    expect(items[0]!.heads.map((h) => h.id)).toEqual([rev(4)]);
  });

  it('tombstones keep history and appear as deleted heads', async () => {
    expect((await pushRevision(rev(5), [rev(4)], true)).statusCode).toBe(201);
    const items = await heads();
    expect(items[0]!.heads).toEqual([expect.objectContaining({ id: rev(5), deleted: true })]);
    // Prior chunk objects still present — nothing was destroyed.
    expect(store.objects.has(`blobs/${vaultId}/${rev(1)}/00000`)).toBe(true);
  });

  it('serves legacy v1 blobs (pre-0.0.4 data) via the streamed whole-blob route', async () => {
    // Seed a legacy revision directly (the API no longer creates them).
    const legacyId = '00000000-0000-4000-8000-0000000000aa';
    const { indexItem, indexRevision } = await import('../store/metadata-log');
    const legacyItem = {
      id: '00000000-0000-4000-8000-0000000000bb',
      vaultId,
      pathHmac: 'b'.repeat(64),
      encryptedPathB64: 'bGVnYWN5',
    };
    indexItem(db, legacyItem);
    indexRevision(db, {
      id: legacyId,
      vaultId,
      itemId: legacyItem.id,
      parentIds: [],
      sizeBytes: 12,
      deviceId: 'dev',
      clientMtime: '2026-07-01T00:00:00.000Z',
      serverReceivedAt: '2026-07-01T00:00:00.000Z',
      deleted: false,
    });
    await store.put(`blobs/${vaultId}/${legacyId}`, 'legacy-bytes');

    const res = await app.inject({
      method: 'GET',
      url: `/vaults/${vaultId}/blobs/${legacyId}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.toString()).toBe('legacy-bytes');
    // Chunked revisions are not served by the legacy route.
    const wrongRoute = await app.inject({
      method: 'GET',
      url: `/vaults/${vaultId}/blobs/${rev(1)}`,
      headers: auth(),
    });
    expect(wrongRoute.statusCode).toBe(404);
  });

  it('rebuild-index reconstructs an identical view from the bucket alone', async () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'vault-sync-rebuild-'));
    const fresh = openDb(freshDir);
    const counts = await rebuildIndex(store, fresh);
    expect(counts).toEqual({ vaults: 1, items: 1, revisions: 5 });

    const config = loadConfig({
      S3_ENDPOINT: 'http://unused',
      S3_ACCESS_KEY: 'x',
      S3_SECRET_KEY: 'x',
      S3_BUCKET: 'unused',
      DATA_DIR: freshDir,
      LOG_LEVEL: 'silent',
      ACCOUNT_PASSWORD_HASH: await hashPassword('correct-password'),
    });
    const app2 = await buildApp({ config, db: fresh, store });
    const login = await app2.inject({
      method: 'POST',
      url: '/login',
      payload: { password: 'correct-password', deviceName: 'rebuilt' },
    });
    const res = await app2.inject({
      method: 'GET',
      url: `/vaults/${vaultId}/heads`,
      headers: { authorization: `Bearer ${login.json().token}` },
    });
    expect(res.json().items[0].heads.map((h: { id: string }) => h.id)).toEqual([rev(5)]);
    await app2.close();
    fresh.close();
    rmSync(freshDir, { recursive: true, force: true });
  });
});
