import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  passwordHashSource,
  readStoredPasswordHash,
  resolvePasswordHash,
  writeStoredPasswordHash,
} from './account';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { openDb, Db } from '../store/db';
import { hashPassword } from '../auth';
import { memoryStore } from '../test-util/memory-store';

describe('account store', () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'vault-sync-account-'));
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns null when no file exists, then round-trips', () => {
    expect(readStoredPasswordHash(dataDir)).toBeNull();
    expect(passwordHashSource(dataDir)).toBe('none');
    expect(passwordHashSource(dataDir, 'env-hash')).toBe('env');

    writeStoredPasswordHash(dataDir, 'scrypt:file-hash');
    expect(readStoredPasswordHash(dataDir)).toBe('scrypt:file-hash');
  });

  it('file wins over env; env is the fallback', () => {
    expect(resolvePasswordHash(dataDir, 'scrypt:env-hash')).toBe('scrypt:file-hash');
    expect(passwordHashSource(dataDir, 'scrypt:env-hash')).toBe('file');

    const emptyDir = mkdtempSync(join(tmpdir(), 'vault-sync-account-empty-'));
    try {
      expect(resolvePasswordHash(emptyDir, 'scrypt:env-hash')).toBe('scrypt:env-hash');
      expect(resolvePasswordHash(emptyDir)).toBeNull();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('login uses the resolved hash', () => {
  let dataDir: string;
  let db: Db;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'vault-sync-setpw-'));
    db = openDb(dataDir);
  });

  afterAll(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('after set-password, the new password logs in and the env password is rejected', async () => {
    const config = loadConfig({
      S3_ENDPOINT: 'http://unused',
      S3_ACCESS_KEY: 'x',
      S3_SECRET_KEY: 'x',
      S3_BUCKET: 'unused',
      DATA_DIR: dataDir,
      LOG_LEVEL: 'silent',
      ACCOUNT_PASSWORD_HASH: await hashPassword('old-env-password'),
    });
    const app = await buildApp({ config, db, store: memoryStore() });
    const login = (password: string) =>
      app.inject({ method: 'POST', url: '/login', payload: { password, deviceName: 'test' } });

    expect((await login('old-env-password')).statusCode).toBe(200);

    // Simulates `admin set-password new-password` on the shared volume;
    // no restart — the route re-resolves per login.
    writeStoredPasswordHash(dataDir, await hashPassword('new-password'));

    expect((await login('new-password')).statusCode).toBe(200);
    expect((await login('old-env-password')).statusCode).toBe(401);
    await app.close();
  });
});
