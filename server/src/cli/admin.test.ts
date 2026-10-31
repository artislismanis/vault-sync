import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, Db } from '../store/db';
import { memoryStore } from '../test-util/memory-store';
import {
  collectStatus,
  formatStatus,
  listDevices,
  listVaults,
  parseArgv,
  storageUsage,
} from './admin-read';

const MB = 1024 * 1024;

describe('parseArgv', () => {
  it('accepts --json before or after the command', () => {
    expect(parseArgv(['--json', 'status'])).toEqual({
      command: 'status',
      args: [],
      json: true,
    });
    expect(parseArgv(['status', '--json'])).toEqual({
      command: 'status',
      args: [],
      json: true,
    });
  });

  it('leaves other args alone and defaults json to false', () => {
    expect(parseArgv(['prune', '--older-days', '30'])).toEqual({
      command: 'prune',
      args: ['--older-days', '30'],
      json: false,
    });
    expect(parseArgv([])).toEqual({ command: undefined, args: [], json: false });
  });
});

describe('read-only admin data', () => {
  let dir: string;
  let db: Db;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'admin-read-'));
    db = openDb(dir);
  });
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const config = { DATA_DIR: '' } as Parameters<typeof collectStatus>[1];

  it('returns empty arrays and a zeroed status when there is nothing to list', async () => {
    const store = memoryStore();
    expect(listVaults(db)).toEqual([]);
    expect(listDevices(db)).toEqual([]);
    expect(await storageUsage(store)).toEqual([]);

    const status = await collectStatus('1.2.3', { ...config, DATA_DIR: dir }, db, store);
    expect(status).toEqual({
      version: '1.2.3',
      bucket_reachable: true,
      auth: 'none',
      vaults: 0,
      revisions: 0,
      devices: 0,
      last_seen: null,
      storage_bytes: 0,
      storage_objects: 0,
    });
  });

  it('uses the table column names for list rows, and survives JSON round-tripping', async () => {
    db.prepare(
      `INSERT INTO vault (id, encrypted_name_b64, kdf_json, wrapped_vmk_b64, created_at, name)
       VALUES ('v1', 'x', '{}', 'x', '2026-07-11T18:03:11.402Z', 'Work Notes'),
              ('v2', 'x', '{}', 'x', '2026-07-12T18:03:11.402Z', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO device (id, name, token_hash, created_at, last_seen)
       VALUES ('d1', 'laptop', 'h1', '2026-07-11T18:00:41.977Z', '2026-07-12T09:14:02.113Z'),
              ('d2', 'phone', 'h2', '2026-07-11T19:22:05.310Z', '2026-07-12T07:48:33.590Z')`,
    ).run();
    const store = memoryStore();
    await store.put('blobs/v1/r1/0', new Uint8Array(MB));
    await store.put('blobs/v1/r1/1', new Uint8Array(MB));
    await store.put('blobs/v2/r2/0', new Uint8Array(MB / 2));

    const vaults = JSON.parse(JSON.stringify(listVaults(db)));
    expect(vaults).toEqual([
      { id: 'v1', name: 'Work Notes', created_at: '2026-07-11T18:03:11.402Z' },
      { id: 'v2', name: null, created_at: '2026-07-12T18:03:11.402Z' },
    ]);
    expect(JSON.parse(JSON.stringify(listDevices(db)))).toEqual([
      {
        id: 'd1',
        name: 'laptop',
        created_at: '2026-07-11T18:00:41.977Z',
        last_seen: '2026-07-12T09:14:02.113Z',
      },
      {
        id: 'd2',
        name: 'phone',
        created_at: '2026-07-11T19:22:05.310Z',
        last_seen: '2026-07-12T07:48:33.590Z',
      },
    ]);
    expect(await storageUsage(store)).toEqual([
      { vault: 'v1', objects: 2, megabytes: 2 },
      { vault: 'v2', objects: 1, megabytes: 0.5 },
    ]);

    const status = await collectStatus('1.2.3', { ...config, DATA_DIR: dir }, db, store);
    expect(status).toMatchObject({
      vaults: 2,
      devices: 2,
      last_seen: '2026-07-12T09:14:02.113Z',
      storage_bytes: 2.5 * MB,
      storage_objects: 3,
    });
    expect(formatStatus(status)).toEqual([
      'vault-sync server 1.2.3',
      'bucket:   reachable',
      'auth:     NO PASSWORD CONFIGURED — logins disabled',
      'vaults:   2 (0 revision(s) total)',
      'devices:  2 (last seen 2026-07-12T09:14:02.113Z)',
      'storage:  2.5 MB in 3 blob object(s)',
    ]);
  });
});

// End-to-end: spawn the real CLI so stdout/stderr/exit-code contracts are tested.
describe('admin CLI --json', () => {
  const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));
  const script = fileURLToPath(new URL('./admin.ts', import.meta.url));
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'admin-cli-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (...argv: string[]) =>
    spawnSync(tsx, [script, ...argv], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        DATA_DIR: dir,
        // Nothing listens here: S3 calls fail fast (no retries) with connection refused.
        S3_ENDPOINT: 'http://127.0.0.1:1',
        S3_ACCESS_KEY: 'k',
        S3_SECRET_KEY: 's',
        S3_BUCKET: 'b',
        AWS_MAX_ATTEMPTS: '1',
      },
    });

  it.each([
    ['after', ['vault-list', '--json']],
    ['before', ['--json', 'vault-list']],
  ])('vault-list prints [] with --json %s the command', (_where, argv) => {
    const res = run(...argv);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual([]);
  });

  it('device-list --json prints [] and nothing else on stdout', () => {
    const res = run('device-list', '--json');
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('[]');
  });

  it('keeps the table output without --json', () => {
    const res = run('vault-list');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('(index)');
  });

  it('rejects --json on other commands without running them', () => {
    const res = run('set-password', 'hunter2', '--json');
    expect(res.status).not.toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('--json is only supported by');
    expect(existsSync(join(dir, 'account.json'))).toBe(false);
  });

  it('rejects --json with no command', () => {
    const res = run('--json');
    expect(res.status).not.toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('--json is only supported by');
  });

  it.each(['storage-usage', 'status'])(
    '%s --json fails on stderr with empty stdout when the bucket is unreachable',
    (command) => {
      const res = run(command, '--json');
      expect(res.status).not.toBe(0);
      expect(res.stdout).toBe('');
      expect(res.stderr).not.toBe('');
    },
    30_000,
  );
});
