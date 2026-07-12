import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loginRequestSchema, LoginResponse } from '@vault-sync/shared';
import { generateToken, verifyPassword } from '../auth';
import type { Config } from '../config';
import type { Db } from '../store/db';
import { resolvePasswordHash } from '../store/account';

// Session tokens are deliberately LOCAL-ONLY state (no bucket sidecar):
// losing the SQLite index just forces clients to re-login. Tokens are stored
// hashed so a leaked index file doesn't leak live credentials.

const PUBLIC_ROUTES = new Set(['/healthz', '/login']);

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function registerAuth(app: FastifyInstance, deps: { config: Config; db: Db }): void {
  app.decorateRequest('deviceId', '');

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    if (PUBLIC_ROUTES.has(path)) return;
    if (path === '/ws') return; // WS authenticates via token query param in its handler

    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const device = token ? findDevice(deps.db, token) : undefined;
    if (!device) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    request.deviceId = device.id;
    deps.db
      .prepare('UPDATE device SET last_seen = ? WHERE id = ?')
      .run(new Date().toISOString(), device.id);
  });

  app.post('/login', async (request, reply): Promise<LoginResponse> => {
    // Re-resolved per login so `admin set-password` (same volume, via docker
    // exec) takes effect without a restart. Changing the password does NOT
    // invalidate existing device tokens — evict devices with device-revoke.
    const passwordHash = resolvePasswordHash(
      deps.config.DATA_DIR,
      deps.config.ACCOUNT_PASSWORD_HASH,
    );
    if (!passwordHash) {
      return reply.code(503).send({ error: 'server has no account password configured' }) as never;
    }
    const body = loginRequestSchema.parse(request.body);
    if (!(await verifyPassword(body.password, passwordHash))) {
      return reply.code(401).send({ error: 'invalid password' }) as never;
    }
    const token = generateToken();
    const deviceId = randomUUID();
    const now = new Date().toISOString();
    deps.db
      .prepare(
        'INSERT INTO device (id, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)',
      )
      .run(deviceId, body.deviceName, hashToken(token), now, now);
    return { token, deviceId: deviceId as LoginResponse['deviceId'] };
  });
}

export function findDevice(db: Db, token: string): { id: string } | undefined {
  return db.prepare('SELECT id FROM device WHERE token_hash = ?').get(hashToken(token)) as
    { id: string } | undefined;
}

declare module 'fastify' {
  interface FastifyRequest {
    deviceId: string;
  }
}

export type { FastifyRequest };
