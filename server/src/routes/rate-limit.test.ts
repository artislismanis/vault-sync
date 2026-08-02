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

// /login is the only unauthenticated route that does real work (scrypt), so
// it is both a password oracle and a CPU-exhaustion vector without a limit.
describe('rate limiting', () => {
  let app: FastifyInstance;
  let db: Db;
  let dataDir: string;
  const store = memoryStore();

  const login = (password: string) =>
    app.inject({
      method: 'POST',
      url: '/login',
      payload: { password, deviceName: 'laptop' },
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'vault-sync-ratelimit-'));
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
  });

  afterAll(async () => {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('blocks brute-force guessing on /login after the attempt budget', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) {
      codes.push((await login('wrong')).statusCode);
    }

    // The budget is 20 per 15 minutes: the first twenty are answered normally
    // (401 invalid password), everything after is refused outright.
    expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429]);
  });

  it('keeps refusing once limited, even with the correct password', async () => {
    // The limiter must not be a password oracle: a correct guess after the
    // budget is exhausted still gets 429, not a token.
    const res = await login('pw');
    expect(res.statusCode).toBe(429);
    expect(res.json().token).toBeUndefined();
  });

  it('leaves /healthz unlimited so uptime probes are never refused', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 30; i++) {
      codes.push((await app.inject({ method: 'GET', url: '/healthz' })).statusCode);
    }
    expect(codes.every((c) => c === 200)).toBe(true);
  });
});
