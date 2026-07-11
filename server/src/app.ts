import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { HealthResponse } from '@vault-sync/shared';
import type { Config } from './config';
import type { Db } from './store/db';
import type { ObjectStore } from './store/s3';
import { Notifier } from './ws/notifier';
import { registerVaultRoutes } from './routes/vaults';

export interface AppDeps {
  config: Config;
  db: Db;
  store: ObjectStore;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: deps.config.LOG_LEVEL },
  });
  await app.register(websocket);

  const notifier = new Notifier();
  app.decorate('notifier', notifier);

  app.get('/healthz', async (): Promise<HealthResponse> => {
    const s3ok = await deps.store.checkBucket();
    return { ok: s3ok, s3: s3ok ? 'ok' : 'unreachable' };
  });

  registerVaultRoutes(app, deps);

  // WS endpoint: clients subscribe per vault; items/revisions/blobs routes
  // will publish through app.notifier as they land.
  app.get('/ws', { websocket: true }, (socket) => {
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
