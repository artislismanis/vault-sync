import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createVaultRequestSchema, ListVaultsResponse, VaultSummary } from '@vault-sync/shared';
import type { Db } from '../store/db';
import type { ObjectStore } from '../store/s3';
import { writeVaultSidecar, indexVault, VaultRecord } from '../store/metadata-log';

// NOTE: auth middleware lands with the session routes; until then these
// endpoints are only suitable for trusted-network dev use.

interface VaultRow {
  id: string;
  encrypted_name_b64: string;
  kdf_json: string;
  wrapped_vmk_b64: string;
  created_at: string;
}

export function registerVaultRoutes(
  app: FastifyInstance,
  deps: { db: Db; store: ObjectStore },
): void {
  app.get('/vaults', async (): Promise<ListVaultsResponse> => {
    const rows = deps.db.prepare('SELECT * FROM vault ORDER BY created_at').all() as VaultRow[];
    return {
      vaults: rows.map(
        (row): VaultSummary => ({
          id: row.id as VaultSummary['id'],
          encryptedNameB64: row.encrypted_name_b64,
          kdf: JSON.parse(row.kdf_json),
          wrappedVmkB64: row.wrapped_vmk_b64,
          createdAt: row.created_at,
        }),
      ),
    };
  });

  app.post('/vaults', async (request, reply) => {
    const body = createVaultRequestSchema.parse(request.body);
    const record: VaultRecord = {
      id: randomUUID(),
      encryptedNameB64: body.encryptedNameB64,
      kdfJson: JSON.stringify(body.kdf),
      wrappedVmkB64: body.wrappedVmkB64,
      createdAt: new Date().toISOString(),
    };
    // Write-ahead: bucket sidecar first, index second, ack last.
    await writeVaultSidecar(deps.store, record);
    indexVault(deps.db, record);
    return reply.code(201).send({ id: record.id });
  });
}
