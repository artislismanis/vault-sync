import { z } from 'zod';
import { vaultIdSchema, itemIdSchema, revisionIdSchema, deviceIdSchema } from './ids';

// REST protocol schemas — the single source of truth for message shapes,
// imported by both server and plugin (CLAUDE.md hard rule 6). Everything the
// server stores or returns here is either opaque ciphertext (B64/hex fields)
// or structural metadata the trust model explicitly permits.

export const kdfParamsSchema = z.object({
  algorithm: z.literal('argon2id'),
  opsLimit: z.number().int().positive(),
  memLimitBytes: z.number().int().positive(),
  saltB64: z.string(),
});

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  s3: z.enum(['ok', 'unreachable']),
});

export const loginRequestSchema = z.object({
  password: z.string(),
  deviceName: z.string().max(64),
});

export const loginResponseSchema = z.object({
  token: z.string(),
  deviceId: deviceIdSchema,
});

export const createVaultRequestSchema = z.object({
  encryptedNameB64: z.string(),
  kdf: kdfParamsSchema,
  wrappedVmkB64: z.string(),
});

export const vaultSummarySchema = z.object({
  id: vaultIdSchema,
  encryptedNameB64: z.string(),
  kdf: kdfParamsSchema,
  wrappedVmkB64: z.string(),
  createdAt: z.iso.datetime(),
});

export const listVaultsResponseSchema = z.object({
  vaults: z.array(vaultSummarySchema),
});

// Blob format v2 fields: present together (chunked secretstream) or absent
// together (legacy v1 single blob, pre-0.0.4 data only).
const chunkFields = {
  chunks: z.number().int().min(1).max(100_000).optional(),
  streamHeaderB64: z.string().optional(),
};

export const revisionSchema = z.object({
  id: revisionIdSchema,
  itemId: itemIdSchema,
  parentIds: z.array(revisionIdSchema),
  sizeBytes: z.number().int().nonnegative(),
  deviceId: deviceIdSchema,
  clientMtime: z.iso.datetime(),
  serverReceivedAt: z.iso.datetime(),
  deleted: z.boolean(),
  ...chunkFields,
});

// Push: client generates the revision id, uploads the blob FIRST
// (PUT /vaults/:id/blobs/:revisionId), then posts this metadata. The server
// verifies the blob exists before accepting; orphan blobs from crashed pushes
// are harmless garbage. Tombstones (deleted: true) carry no blob.
export const pushRevisionRequestSchema = z.object({
  id: revisionIdSchema,
  pathHmac: z.string().regex(/^[0-9a-f]{64}$/),
  encryptedPathB64: z.string(),
  parentIds: z.array(revisionIdSchema),
  sizeBytes: z.number().int().nonnegative(),
  clientMtime: z.iso.datetime(),
  deleted: z.boolean(),
  ...chunkFields,
});

export const itemHeadsSchema = z.object({
  itemId: itemIdSchema,
  pathHmac: z.string(),
  encryptedPathB64: z.string(),
  // Multiple heads = concurrent edits awaiting client-side resolution.
  heads: z.array(revisionSchema).min(1),
});

export const headsResponseSchema = z.object({
  items: z.array(itemHeadsSchema),
});

export type KdfParams = z.infer<typeof kdfParamsSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type CreateVaultRequest = z.infer<typeof createVaultRequestSchema>;
export type VaultSummary = z.infer<typeof vaultSummarySchema>;
export type ListVaultsResponse = z.infer<typeof listVaultsResponseSchema>;
export type Revision = z.infer<typeof revisionSchema>;
export type PushRevisionRequest = z.infer<typeof pushRevisionRequestSchema>;
export type ItemHeads = z.infer<typeof itemHeadsSchema>;
export type HeadsResponse = z.infer<typeof headsResponseSchema>;
