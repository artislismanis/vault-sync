import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../store/db';

// Runs the real CLI entry point as a subprocess: --json argument handling and
// the "stdout is one JSON document or empty" contract live in main(), which
// has no seam to call in-process.

const SERVER_DIR = join(__dirname, '..', '..');
let dataDir: string;

function admin(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/admin.ts', ...args], {
    cwd: SERVER_DIR,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      DATA_DIR: dataDir,
      // Nothing listens on port 1: any bucket access fails fast.
      S3_ENDPOINT: 'http://127.0.0.1:1',
      S3_ACCESS_KEY: 'x',
      S3_SECRET_KEY: 'x',
      S3_BUCKET: 'x',
      ...env,
    },
  });
  return { stdout: result.stdout, stderr: result.stderr, code: result.status };
}

describe('admin CLI --json', () => {
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'admin-cli-'));
    const db = openDb(dataDir);
    db.prepare(
      "INSERT INTO vault (id, encrypted_name_b64, kdf_json, wrapped_vmk_b64, created_at, name) VALUES ('v1', '', '{}', '', '2026-07-11T00:00:00.000Z', 'Work Notes')",
    ).run();
    db.prepare(
      "INSERT INTO device (id, name, token_hash, created_at, last_seen) VALUES ('d1', 'laptop', 'h', '2026-07-11T00:00:00.000Z', '2026-07-12T00:00:00.000Z')",
    ).run();
    db.close();
  }, 30_000);
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it('vault-list prints one JSON array and nothing else', () => {
    const { stdout, stderr, code } = admin(['vault-list', '--json']);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual([
      { id: 'v1', name: 'Work Notes', created_at: '2026-07-11T00:00:00.000Z' },
    ]);
  }, 30_000);

  it('accepts --json before the command name', () => {
    const { stdout, code } = admin(['--json', 'device-list']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      {
        id: 'd1',
        name: 'laptop',
        created_at: '2026-07-11T00:00:00.000Z',
        last_seen: '2026-07-12T00:00:00.000Z',
      },
    ]);
  }, 30_000);

  it('prints [] for an empty list', () => {
    const empty = mkdtempSync(join(tmpdir(), 'admin-cli-empty-'));
    try {
      const { stdout, code } = admin(['vault-list', '--json'], { DATA_DIR: empty });
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }, 30_000);

  it('leaves the table output unchanged without --json', () => {
    const { stdout, code } = admin(['vault-list']);
    expect(code).toBe(0);
    expect(stdout).toContain('(index)');
    expect(stdout).toContain("'Work Notes'");
  }, 30_000);

  it.each([
    ['set-password', 'secret'],
    ['hash-password', 'secret'],
    ['device-revoke', 'd1'],
    ['prune', '--older-days'],
  ])(
    'rejects --json on %s without running it',
    (command, arg) => {
      const { stdout, stderr, code } = admin([command, arg!, '--json']);
      expect(code).not.toBe(0);
      expect(stdout).toBe('');
      expect(stderr).toContain('--json is only supported by');
    },
    30_000,
  );

  it('does not perform a rejected command', () => {
    expect(admin(['device-revoke', 'd1', '--json']).code).not.toBe(0);
    const listed = JSON.parse(admin(['device-list', '--json']).stdout) as unknown[];
    expect(listed).toHaveLength(1);
  }, 60_000);

  it('rejects --json with no command', () => {
    const { stdout, stderr, code } = admin(['--json']);
    expect(code).not.toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('--json is only supported by');
  }, 30_000);

  it.each(['status', 'storage-usage'])(
    '%s --json fails with empty stdout when the bucket is unreachable',
    (command) => {
      const { stdout, stderr, code } = admin([command, '--json']);
      expect(code).not.toBe(0);
      expect(stdout).toBe('');
      expect(stderr).not.toBe('');
    },
    60_000,
  );

  it('fails with empty stdout on invalid configuration', () => {
    const { stdout, stderr, code } = admin(['vault-list', '--json'], { S3_BUCKET: '' });
    expect(code).not.toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('invalid configuration');
  }, 30_000);
});
