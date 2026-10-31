import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, Db } from '../store/db';
import { memoryStore } from '../test-util/memory-store';
import {
  collectDeviceList,
  collectStatus,
  collectStorageUsage,
  collectVaultList,
  formatStatus,
  parseArgs,
  statusJson,
} from './read-commands';

describe('parseArgs', () => {
  it('accepts --json before or after the command name', () => {
    expect(parseArgs(['--json', 'vault-list'])).toEqual({
      command: 'vault-list',
      args: [],
      json: true,
    });
    expect(parseArgs(['vault-list', '--json'])).toEqual({
      command: 'vault-list',
      args: [],
      json: true,
    });
  });

  it('leaves other arguments alone and defaults to text output', () => {
    expect(parseArgs(['prune', '--older-days', '5'])).toEqual({
      command: 'prune',
      args: ['--older-days', '5'],
      json: false,
    });
  });
});

describe('collectors', () => {
  let db: Db;
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'vault-sync-cli-'));
    db = openDb(dataDir);
  });
  afterAll(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns empty arrays when there is nothing to list', async () => {
    expect(collectVaultList(db)).toEqual([]);
    expect(collectDeviceList(db)).toEqual([]);
    expect(await collectStorageUsage(memoryStore())).toEqual([]);
  });

  it('lists vaults and devices with the table column names', () => {
    db.prepare(
      "INSERT INTO vault (id, name, encrypted_name_b64, kdf_json, wrapped_vmk_b64, created_at) VALUES ('v1', 'Work', 'x', '{}', 'x', '2026-01-01')",
    ).run();
    db.prepare(
      "INSERT INTO device (id, name, token_hash, created_at, last_seen) VALUES ('d1', 'laptop', 'h', '2026-01-02', '2026-01-03')",
    ).run();
    expect(collectVaultList(db)).toEqual([{ id: 'v1', name: 'Work', created_at: '2026-01-01' }]);
    expect(collectDeviceList(db)).toEqual([
      { id: 'd1', name: 'laptop', created_at: '2026-01-02', last_seen: '2026-01-03' },
    ]);
  });

  it('sums blob storage per vault', async () => {
    const store = memoryStore();
    await store.put('blobs/v1/r1/0', new Uint8Array(1024 * 1024));
    await store.put('blobs/v1/r1/1', new Uint8Array(1024 * 1024));
    await store.put('blobs/v2/r2/0', new Uint8Array(10));
    expect(await collectStorageUsage(store)).toEqual([
      { vault: 'v1', objects: 2, megabytes: 2 },
      { vault: 'v2', objects: 1, megabytes: 0 },
    ]);
  });

  it('builds a status report and renders the unchanged text form', async () => {
    const store = memoryStore();
    await store.put('blobs/v1/r1/0', new Uint8Array(1024 * 1024));
    const status = await collectStatus(db, store, '1.2.3', 'env');
    expect(status).toEqual({
      version: '1.2.3',
      bucketReachable: true,
      authSource: 'env',
      vaults: 1,
      revisions: 0,
      devices: 1,
      lastSeen: '2026-01-03',
      storage: { megabytes: 1, objects: 1 },
    });
    expect(formatStatus(status)).toEqual([
      'vault-sync server 1.2.3',
      'bucket:   reachable',
      'auth:     password hash from env',
      'vaults:   1 (0 revision(s) total)',
      'devices:  1 (last seen 2026-01-03)',
      'storage:  1 MB in 1 blob object(s)',
    ]);
    expect(JSON.parse(statusJson(status))).toEqual(status);
  });

  it('refuses to emit status JSON when the bucket is unreachable', async () => {
    const store = { ...memoryStore(), checkBucket: async () => false };
    const status = await collectStatus(db, store, '1.2.3', 'none');
    expect(() => statusJson(status)).toThrow(/bucket unreachable/);
    expect(formatStatus(status)[1]).toContain('UNREACHABLE');
  });
});

// End-to-end: run the real CLI so flag handling and stdout/stderr discipline
// are exercised, not just the collectors.
describe('admin CLI --json', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'vault-sync-cli-e2e-'));
  });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  const run = (...argv: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/admin.ts', ...argv], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: process.env.PATH,
        DATA_DIR: dataDir,
        // Nothing listens here: any storage access fails.
        S3_ENDPOINT: 'http://127.0.0.1:1',
        S3_ACCESS_KEY: 'k',
        S3_SECRET_KEY: 's',
        S3_BUCKET: 'b',
      },
    });

  it.each([
    ['--json', 'vault-list'],
    ['vault-list', '--json'],
    ['device-list', '--json'],
  ])('prints [] for an empty list: %s %s', (...argv) => {
    const res = run(...argv);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual([]);
    expect(res.stderr).toBe('');
  });

  it('keeps the table output without --json', () => {
    const res = run('vault-list');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('(index)');
  });

  it.each([['storage-usage'], ['status']])(
    'fails with empty stdout and a stderr message when the bucket is unreachable: %s',
    (command) => {
      const res = run(command, '--json');
      expect(res.status).not.toBe(0);
      expect(res.stdout).toBe('');
      expect(res.stderr).not.toBe('');
    },
  );

  it.each([
    ['set-password', 'hunter2', '--json'],
    ['--json', 'device-revoke', 'abc'],
    ['hash-password', 'x', '--json'],
    ['prune', '--older-days', '1', '--json'],
    ['--json'],
  ])('rejects --json on other commands without running them: %s', (...argv) => {
    const res = run(...argv);
    expect(res.status).not.toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('--json is only supported by');
    // set-password would have written account.json had it run.
    expect(readdirSync(dataDir)).not.toContain('account.json');
  });
});
