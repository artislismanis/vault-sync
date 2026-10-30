import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, Db } from '../store/db';
import { memoryStore } from '../test-util/memory-store';
import {
  collectStatus,
  extractJsonFlag,
  listDevices,
  listVaults,
  storageUsage,
} from './admin-read';

describe('extractJsonFlag', () => {
  it('finds --json before or after the command and removes it', () => {
    expect(extractJsonFlag(['--json', 'status'])).toEqual({ json: true, argv: ['status'] });
    expect(extractJsonFlag(['status', '--json'])).toEqual({ json: true, argv: ['status'] });
  });

  it('leaves argv alone without the flag', () => {
    expect(extractJsonFlag(['prune', '--yes'])).toEqual({ json: false, argv: ['prune', '--yes'] });
  });
});

describe('read-only admin data', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'admin-read-'));
    db = openDb(dir);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const addVault = (id: string, name: string | null, createdAt: string) =>
    db
      .prepare(
        "INSERT INTO vault (id, encrypted_name_b64, kdf_json, wrapped_vmk_b64, created_at, name) VALUES (?, '', '{}', '', ?, ?)",
      )
      .run(id, createdAt, name);
  const addDevice = (id: string, name: string, createdAt: string, lastSeen: string) =>
    db
      .prepare(
        'INSERT INTO device (id, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, name, `hash-${id}`, createdAt, lastSeen);

  it('returns empty lists when there is nothing to list', async () => {
    expect(listVaults(db)).toEqual([]);
    expect(listDevices(db)).toEqual([]);
    expect(await storageUsage(memoryStore())).toEqual([]);
  });

  it('lists vaults with the table column names, null name preserved', () => {
    addVault('v2', null, '2026-07-12T00:00:00.000Z');
    addVault('v1', 'Work Notes', '2026-07-11T00:00:00.000Z');
    expect(listVaults(db)).toEqual([
      { id: 'v1', name: 'Work Notes', created_at: '2026-07-11T00:00:00.000Z' },
      { id: 'v2', name: null, created_at: '2026-07-12T00:00:00.000Z' },
    ]);
  });

  it('lists devices newest-seen first without token hashes', () => {
    addDevice('d1', 'laptop', '2026-07-11T00:00:00.000Z', '2026-07-12T09:00:00.000Z');
    addDevice('d2', 'phone', '2026-07-11T01:00:00.000Z', '2026-07-12T10:00:00.000Z');
    expect(listDevices(db)).toEqual([
      {
        id: 'd2',
        name: 'phone',
        created_at: '2026-07-11T01:00:00.000Z',
        last_seen: '2026-07-12T10:00:00.000Z',
      },
      {
        id: 'd1',
        name: 'laptop',
        created_at: '2026-07-11T00:00:00.000Z',
        last_seen: '2026-07-12T09:00:00.000Z',
      },
    ]);
  });

  it('sums blob storage per vault', async () => {
    const store = memoryStore();
    await store.put('blobs/va/r1/0', new Uint8Array(1024 * 1024));
    await store.put('blobs/va/r1/1', new Uint8Array(1024 * 1024));
    await store.put('blobs/vb/r2/0', new Uint8Array(512 * 1024));
    await store.put('meta/va/vault.json', '{}');
    expect(await storageUsage(store)).toEqual([
      { vault: 'va', objects: 2, megabytes: 2 },
      { vault: 'vb', objects: 1, megabytes: 0.5 },
    ]);
  });

  it('builds the status report', async () => {
    addVault('v1', 'Work Notes', '2026-07-11T00:00:00.000Z');
    addDevice('d1', 'laptop', '2026-07-11T00:00:00.000Z', '2026-07-12T09:00:00.000Z');
    const store = memoryStore();
    await store.put('blobs/v1/r1/0', new Uint8Array(1024 * 1024));
    expect(await collectStatus(db, store, '1.2.3', 'env')).toEqual({
      version: '1.2.3',
      bucket: 'reachable',
      auth: 'env',
      vaults: 1,
      revisions: 0,
      devices: 1,
      last_seen: '2026-07-12T09:00:00.000Z',
      blob_objects: 1,
      blob_megabytes: 1,
    });
  });

  it('reports an unreachable bucket and no devices as null last_seen', async () => {
    const store = { ...memoryStore(), checkBucket: async () => false };
    const report = await collectStatus(db, store, '1.2.3', 'none');
    expect(report).toMatchObject({ bucket: 'unreachable', auth: 'none', last_seen: null });
  });
});
