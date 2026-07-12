import type { FastifyInstance } from 'fastify';
import { renameDeviceRequestSchema, ListDevicesResponse, DeviceInfo } from '@vault-sync/shared';
import type { Db } from '../store/db';

// Device names are user-supplied plaintext already held server-side (set at
// login). Exposing them to authenticated devices lets the plugin label
// version-history entries by device; token_hash is never selected.

interface DeviceRow {
  id: string;
  name: string;
  created_at: string;
  last_seen: string;
}

export function registerDeviceRoutes(app: FastifyInstance, deps: { db: Db }): void {
  app.get('/devices', async (): Promise<ListDevicesResponse> => {
    const rows = deps.db
      .prepare('SELECT id, name, created_at, last_seen FROM device ORDER BY last_seen DESC')
      .all() as DeviceRow[];
    return {
      devices: rows.map((row): DeviceInfo => ({
        id: row.id as DeviceInfo['id'],
        name: row.name,
        createdAt: row.created_at,
        lastSeen: row.last_seen,
      })),
    };
  });

  // Renames the calling device only (deviceId comes from the auth token, so a
  // device can never rename another). Keeps the server-side label current when
  // the user edits the device name in plugin settings after login.
  app.patch('/devices/self', async (request, reply) => {
    const body = renameDeviceRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'name must be 1-64 characters' });
    }
    deps.db
      .prepare('UPDATE device SET name = ? WHERE id = ?')
      .run(body.data.name, request.deviceId);
    return reply.code(204).send();
  });
}
