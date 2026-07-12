import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { openDb, Db } from '../store/db';
import { hashPassword } from '../auth';
import { memoryStore } from '../test-util/memory-store';
import { vaultMetaKey } from '../store/metadata-log';

describe('vault routes: update & delete', () => {
  let app: FastifyInstance;
  let db: Db;
  let dataDir: string;
  let token: string;
  const store = memoryStore();

  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const kdf = (salt: string) => ({
    algorithm: 'argon2id' as const,
    opsLimit: 3,
    memLimitBytes: 67108864,
    saltB64: salt,
  });

  const createVault = async (): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/vaults',
      headers: auth(token),
      payload: {
        encryptedNameB64: 'bmFtZQ==',
        kdf: kdf('c2FsdA=='),
        wrappedVmkB64: 'dm1r',
        kind: 'vault',
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  };

  const summary = async (id: string) => {
    const list = await app.inject({ method: 'GET', url: '/vaults', headers: auth(token) });
    return list.json().vaults.find((v: { id: string }) => v.id === id);
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'vault-sync-vaults-'));
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
    app = await buildApp({ config, db, store });
    const login = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { password: 'pw', deviceName: 'laptop' },
    });
    token = login.json().token;
  });

  afterAll(async () => {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('requires auth for PATCH and DELETE', async () => {
    const id = await createVault();
    expect(
      (await app.inject({ method: 'PATCH', url: `/vaults/${id}`, payload: { encryptedNameB64: 'eA==' } }))
        .statusCode,
    ).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: `/vaults/${id}` })).statusCode).toBe(401);
  });

  it('PATCH renames: updates encrypted name + sidecar, leaves the envelope', async () => {
    const id = await createVault();
    const res = await app.inject({
      method: 'PATCH',
      url: `/vaults/${id}`,
      headers: auth(token),
      payload: { encryptedNameB64: 'bmV3bmFtZQ==' },
    });
    expect(res.statusCode).toBe(204);

    const v = await summary(id);
    expect(v.encryptedNameB64).toBe('bmV3bmFtZQ==');
    expect(v.wrappedVmkB64).toBe('dm1r'); // unchanged
    expect(v.kdf.saltB64).toBe('c2FsdA==');

    const sidecar = JSON.parse(new TextDecoder().decode(await store.get(vaultMetaKey(id))));
    expect(sidecar.encryptedNameB64).toBe('bmV3bmFtZQ==');
  });

  it('PATCH changes passphrase: updates kdf + wrapped VMK, leaves the name', async () => {
    const id = await createVault();
    const res = await app.inject({
      method: 'PATCH',
      url: `/vaults/${id}`,
      headers: auth(token),
      payload: { kdf: kdf('bmV3c2FsdA=='), wrappedVmkB64: 'bmV3dm1r' },
    });
    expect(res.statusCode).toBe(204);

    const v = await summary(id);
    expect(v.wrappedVmkB64).toBe('bmV3dm1r');
    expect(v.kdf.saltB64).toBe('bmV3c2FsdA==');
    expect(v.encryptedNameB64).toBe('bmFtZQ=='); // unchanged
  });

  it('PATCH rejects an empty / half-specified body', async () => {
    const id = await createVault();
    expect(
      (await app.inject({ method: 'PATCH', url: `/vaults/${id}`, headers: auth(token), payload: {} }))
        .statusCode,
    ).toBe(400);
    // kdf without wrappedVmkB64 (and no rename) fails the paired-fields refine.
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/vaults/${id}`,
          headers: auth(token),
          payload: { kdf: kdf('eA==') },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('PATCH returns 404 for an unknown vault', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/vaults/00000000-0000-4000-8000-000000000099',
      headers: auth(token),
      payload: { encryptedNameB64: 'eA==' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE removes the vault and its sidecar', async () => {
    const id = await createVault();
    const res = await app.inject({ method: 'DELETE', url: `/vaults/${id}`, headers: auth(token) });
    expect(res.statusCode).toBe(204);
    expect(await summary(id)).toBeUndefined();
    expect(store.objects.has(vaultMetaKey(id))).toBe(false);
  });
});
