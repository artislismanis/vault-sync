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

describe('device routes', () => {
  let app: FastifyInstance;
  let db: Db;
  let dataDir: string;
  let laptopToken: string;
  let laptopId: string;
  let phoneId: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'vault-sync-devices-'));
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

    const laptop = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { password: 'pw', deviceName: 'laptop' },
    });
    laptopToken = laptop.json().token;
    laptopId = laptop.json().deviceId;
    const phone = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { password: 'pw', deviceName: 'phone' },
    });
    phoneId = phone.json().deviceId;
  });

  afterAll(async () => {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('requires auth', async () => {
    expect((await app.inject({ method: 'GET', url: '/devices' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'PATCH', url: '/devices/self', payload: { name: 'x' } }))
        .statusCode,
    ).toBe(401);
  });

  it('lists all devices without token hashes', async () => {
    const res = await app.inject({ method: 'GET', url: '/devices', headers: auth(laptopToken) });
    expect(res.statusCode).toBe(200);
    const { devices } = res.json();
    expect(devices.map((d: { name: string }) => d.name).sort()).toEqual(['laptop', 'phone']);
    for (const device of devices) {
      expect(Object.keys(device).sort()).toEqual(['createdAt', 'id', 'lastSeen', 'name']);
    }
  });

  it('PATCH /devices/self renames only the calling device', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/devices/self',
      headers: auth(laptopToken),
      payload: { name: 'work-laptop' },
    });
    expect(res.statusCode).toBe(204);

    const list = await app.inject({ method: 'GET', url: '/devices', headers: auth(laptopToken) });
    const byId = new Map(
      list.json().devices.map((d: { id: string; name: string }) => [d.id, d.name]),
    );
    expect(byId.get(laptopId)).toBe('work-laptop');
    expect(byId.get(phoneId)).toBe('phone');
  });

  it('rejects invalid names', async () => {
    const tooLong = await app.inject({
      method: 'PATCH',
      url: '/devices/self',
      headers: auth(laptopToken),
      payload: { name: 'x'.repeat(65) },
    });
    expect(tooLong.statusCode).toBe(400);
    const empty = await app.inject({
      method: 'PATCH',
      url: '/devices/self',
      headers: auth(laptopToken),
      payload: { name: '' },
    });
    expect(empty.statusCode).toBe(400);
  });
});
