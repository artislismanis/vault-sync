import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { HealthResponse } from '@vault-sync/shared';
import type { Config } from './config';
import type { Db } from './store/db';
import type { ObjectStore } from './store/s3';
import { Notifier } from './ws/notifier';
import { registerAuth, findDevice } from './routes/auth';
import { registerVaultRoutes } from './routes/vaults';
import { registerSyncRoutes } from './routes/sync';

export interface AppDeps {
  config: Config;
  db: Db;
  store: ObjectStore;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: deps.config.LOG_LEVEL },
    // Whole-file sync: cap request bodies well above the plugin's default
    // selective-sync size cap. Revisit with chunked upload (phase 2).
    bodyLimit: 256 * 1024 * 1024,
  });
  await app.register(websocket);

  const notifier = new Notifier();
  app.decorate('notifier', notifier);

  registerAuth(app, deps);

  app.get('/healthz', async (): Promise<HealthResponse> => {
    const s3ok = await deps.store.checkBucket();
    return { ok: s3ok, s3: s3ok ? 'ok' : 'unreachable' };
  });

  registerVaultRoutes(app, deps);
  registerSyncRoutes(app, { ...deps, notifier });

  // Change-notification channel. Auth via ?token= (browsers/webviews can't
  // set headers on WebSocket connects); subscribe per vault after connecting.
  app.get<{ Querystring: { token?: string } }>('/ws', { websocket: true }, (socket, request) => {
    const token = request.query.token;
    if (!token || !findDevice(deps.db, token)) {
      socket.close(4401, 'unauthorized');
      return;
    }
    socket.on('message', (raw: Buffer) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message?.type === 'subscribe' && typeof message.vaultId === 'string') {
          notifier.subscribe(message.vaultId, socket);
        }
      } catch {
        socket.close(1003, 'invalid message');
      }
    });
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    notifier: Notifier;
  }
}
