import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  pushRevisionRequestSchema,
  HeadsResponse,
  ItemHeads,
  Revision,
} from '@vault-sync/shared';
import type { Db } from '../store/db';
import type { ObjectStore } from '../store/s3';
import {
  blobKey,
  chunkKey,
  chunkPrefix,
  indexItem,
  indexRevision,
  writeItemSidecar,
  writeRevisionSidecar,
  ItemRecord,
  RevisionRecord,
} from '../store/metadata-log';
import type { Notifier } from '../ws/notifier';

interface ItemRow {
  id: string;
  path_hmac: string;
  encrypted_path_b64: string;
}

interface RevisionRow {
  id: string;
  item_id: string;
  parent_ids_json: string;
  size_bytes: number;
  device_id: string;
  client_mtime: string;
  server_received_at: string;
  deleted: number;
  chunks: number | null;
  stream_header_b64: string | null;
}

function toRevision(row: RevisionRow): Revision {
  return {
    id: row.id,
    itemId: row.item_id,
    parentIds: JSON.parse(row.parent_ids_json),
    sizeBytes: row.size_bytes,
    deviceId: row.device_id,
    clientMtime: row.client_mtime,
    serverReceivedAt: row.server_received_at,
    deleted: row.deleted === 1,
    ...(row.chunks != null ? { chunks: row.chunks } : {}),
    ...(row.stream_header_b64 != null ? { streamHeaderB64: row.stream_header_b64 } : {}),
  } as Revision;
}

const SEQ_PATTERN = /^\d{1,5}$/;

export function registerSyncRoutes(
  app: FastifyInstance,
  deps: { db: Db; store: ObjectStore; notifier: Notifier },
): void {
  const { db, store } = deps;

  const vaultExists = (vaultId: string): boolean =>
    db.prepare('SELECT 1 FROM vault WHERE id = ?').get(vaultId) !== undefined;

  const findRevisionInVault = (vaultId: string, revisionId: string): RevisionRow | undefined =>
    db
      .prepare(
        `SELECT r.* FROM revision r JOIN item i ON r.item_id = i.id
         WHERE r.id = ? AND i.vault_id = ?`,
      )
      .get(revisionId, vaultId) as RevisionRow | undefined;

  // Raw ciphertext bodies for chunk upload.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  app.put<{ Params: { vaultId: string; revisionId: string; seq: string } }>(
    '/vaults/:vaultId/blobs/:revisionId/chunks/:seq',
    async (request, reply) => {
      const { vaultId, revisionId, seq } = request.params;
      if (!vaultExists(vaultId)) return reply.code(404).send({ error: 'unknown vault' });
      if (!SEQ_PATTERN.test(seq)) return reply.code(400).send({ error: 'invalid chunk seq' });
      const body = request.body as Buffer | undefined;
      if (!Buffer.isBuffer(body)) {
        return reply.code(400).send({ error: 'expected application/octet-stream body' });
      }
      // Idempotent: a retried chunk overwrites identical ciphertext.
      await store.put(chunkKey(vaultId, revisionId, Number(seq)), body);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { vaultId: string; revisionId: string; seq: string } }>(
    '/vaults/:vaultId/blobs/:revisionId/chunks/:seq',
    async (request, reply) => {
      const { vaultId, revisionId, seq } = request.params;
      if (!vaultExists(vaultId)) return reply.code(404).send({ error: 'unknown vault' });
      if (!SEQ_PATTERN.test(seq)) return reply.code(400).send({ error: 'invalid chunk seq' });
      const revision = findRevisionInVault(vaultId, revisionId);
      if (!revision || revision.chunks == null || Number(seq) >= revision.chunks) {
        return reply.code(404).send({ error: 'unknown chunk' });
      }
      const bytes = await store.get(chunkKey(vaultId, revisionId, Number(seq)));
      return reply
        .type('application/octet-stream')
        .send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    },
  );

  // Legacy v1 whole-blob GET — pre-0.0.4 revisions only. Streams straight
  // from the object store; never buffers the blob in server memory.
  app.get<{ Params: { vaultId: string; revisionId: string } }>(
    '/vaults/:vaultId/blobs/:revisionId',
    async (request, reply) => {
      const { vaultId, revisionId } = request.params;
      if (!vaultExists(vaultId)) return reply.code(404).send({ error: 'unknown vault' });
      const revision = findRevisionInVault(vaultId, revisionId);
      if (!revision || revision.chunks != null) {
        return reply.code(404).send({ error: 'unknown legacy blob' });
      }
      return reply
        .type('application/octet-stream')
        .send(await store.getStream(blobKey(vaultId, revisionId)));
    },
  );

  app.post<{ Params: { vaultId: string } }>(
    '/vaults/:vaultId/revisions',
    async (request, reply) => {
      const { vaultId } = request.params;
      if (!vaultExists(vaultId)) return reply.code(404).send({ error: 'unknown vault' });
      const body = pushRevisionRequestSchema.parse(request.body);

      if (db.prepare('SELECT 1 FROM revision WHERE id = ?').get(body.id)) {
        return reply.code(409).send({ error: 'revision id already exists' });
      }

      const chunked = body.chunks != null;
      if (chunked !== (body.streamHeaderB64 != null)) {
        return reply.code(400).send({ error: 'chunks and streamHeaderB64 must appear together' });
      }
      if (!body.deleted && !chunked) {
        return reply
          .code(400)
          .send({ error: 'chunked upload required (legacy whole-blob push removed in 0.0.4)' });
      }
      if (body.deleted && chunked) {
        return reply.code(400).send({ error: 'tombstones carry no content' });
      }

      if (chunked) {
        // All chunks must be durable, and exactly the declared set — gaps or
        // stray keys reject the revision.
        const keys = new Set(await store.list(chunkPrefix(vaultId, body.id)));
        const expected = new Set(
          Array.from({ length: body.chunks! }, (_, i) => chunkKey(vaultId, body.id, i)),
        );
        const missing = [...expected].some((k) => !keys.has(k));
        const stray = [...keys].some((k) => !expected.has(k));
        if (missing || stray) {
          return reply.code(400).send({
            error: `chunk set mismatch: expected ${body.chunks}, found ${keys.size}${stray ? ' (stray keys)' : ''}`,
          });
        }
      }

      let item = db
        .prepare('SELECT id, path_hmac, encrypted_path_b64 FROM item WHERE vault_id = ? AND path_hmac = ?')
        .get(vaultId, body.pathHmac) as ItemRow | undefined;
      if (!item) {
        const record: ItemRecord = {
          id: randomUUID(),
          vaultId,
          pathHmac: body.pathHmac,
          encryptedPathB64: body.encryptedPathB64,
        };
        await writeItemSidecar(store, record);
        indexItem(db, record);
        item = {
          id: record.id,
          path_hmac: record.pathHmac,
          encrypted_path_b64: record.encryptedPathB64,
        };
      }

      const record: RevisionRecord = {
        id: body.id,
        vaultId,
        itemId: item.id,
        parentIds: body.parentIds,
        sizeBytes: body.sizeBytes,
        deviceId: request.deviceId,
        clientMtime: body.clientMtime,
        serverReceivedAt: new Date().toISOString(),
        deleted: body.deleted,
        ...(chunked ? { chunks: body.chunks, streamHeaderB64: body.streamHeaderB64 } : {}),
      };
      // Write-ahead: sidecar first, index second, notify+ack last. The server
      // NEVER rejects on conflict — concurrent heads live in the DAG.
      await writeRevisionSidecar(store, record);
      indexRevision(db, record);
      deps.notifier.notify({
        type: 'changed',
        vaultId,
        itemIds: [item.id],
        originDeviceId: request.deviceId,
      } as Parameters<Notifier['notify']>[0]);

      const row = db.prepare('SELECT * FROM revision WHERE id = ?').get(record.id) as RevisionRow;
      return reply.code(201).send(toRevision(row));
    },
  );

  app.get<{ Params: { vaultId: string } }>(
    '/vaults/:vaultId/heads',
    async (request, reply): Promise<HeadsResponse> => {
      const { vaultId } = request.params;
      if (!vaultExists(vaultId)) return reply.code(404).send({ error: 'unknown vault' }) as never;

      const items = db
        .prepare('SELECT id, path_hmac, encrypted_path_b64 FROM item WHERE vault_id = ?')
        .all(vaultId) as ItemRow[];

      // Heads = revisions not cited as a parent by any other revision of the
      // same item.
      const headsStmt = db.prepare(
        `SELECT r.* FROM revision r
         WHERE r.item_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM revision r2, json_each(r2.parent_ids_json) p
             WHERE r2.item_id = r.item_id AND p.value = r.id
           )
         ORDER BY r.server_received_at`,
      );

      const result: ItemHeads[] = [];
      for (const item of items) {
        const heads = (headsStmt.all(item.id) as RevisionRow[]).map(toRevision);
        if (heads.length === 0) continue;
        result.push({
          itemId: item.id,
          pathHmac: item.path_hmac,
          encryptedPathB64: item.encrypted_path_b64,
          heads,
        } as ItemHeads);
      }
      return { items: result };
    },
  );
}
