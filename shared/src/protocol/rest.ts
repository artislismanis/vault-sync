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
  // Optional so clients tolerate pre-0.0.5 servers.
  version: z.string().optional(),
});

export const loginRequestSchema = z.object({
  password: z.string(),
  deviceName: z.string().max(64),
});

export const loginResponseSchema = z.object({
  token: z.string(),
  deviceId: deviceIdSchema,
});

// Device names are user-supplied plaintext the server already stores (set at
// login); listing them to the single user's own authenticated devices adds no
// exposure. token_hash never appears in any response.
export const deviceInfoSchema = z.object({
  id: deviceIdSchema,
  name: z.string(),
  createdAt: z.iso.datetime(),
  lastSeen: z.iso.datetime(),
});

export const listDevicesResponseSchema = z.object({
  devices: z.array(deviceInfoSchema),
});

export const renameDeviceRequestSchema = z.object({
  name: z.string().min(1).max(64),
});

// Structural, non-secret vault classification. Lets a device that has not
// unlocked a vault still tell a folder-share ("folder") from a full vault
// ("vault") so the settings dropdowns can offer the right candidates. Not
// plaintext content/names/paths — no E2EE weakening (docs/decisions.md).
export const vaultKindSchema = z.enum(['vault', 'folder']).default('vault');

export const createVaultRequestSchema = z.object({
  encryptedNameB64: z.string(),
  kdf: kdfParamsSchema,
  wrappedVmkB64: z.string(),
  kind: vaultKindSchema,
});

export const updateVaultRequestSchema = z
  .object({
    encryptedNameB64: z.string().optional(), // rename
    kdf: kdfParamsSchema.optional(), // passphrase change …
    wrappedVmkB64: z.string().optional(), // … (both together)
  })
  .refine((v) => v.encryptedNameB64 !== undefined || (v.kdf && v.wrappedVmkB64), {
    message: 'update must rename or change passphrase',
  })
  .refine((v) => (v.kdf === undefined) === (v.wrappedVmkB64 === undefined), {
    message: 'kdf and wrappedVmkB64 must be set together',
  });

export const vaultSummarySchema = z.object({
  id: vaultIdSchema,
  encryptedNameB64: z.string(),
  kdf: kdfParamsSchema,
  wrappedVmkB64: z.string(),
  createdAt: z.iso.datetime(),
  kind: vaultKindSchema,
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

// Full per-item history (newest first), for the plugin's version-history UI.
// Restore is client-side: fetch an old revision's blob, write it locally,
// push as a NEW revision citing the current head — history never rewrites.
export const historyResponseSchema = z.object({
  itemId: itemIdSchema,
  revisions: z.array(revisionSchema).min(1),
});

export type KdfParams = z.infer<typeof kdfParamsSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;
export type ListDevicesResponse = z.infer<typeof listDevicesResponseSchema>;
export type RenameDeviceRequest = z.infer<typeof renameDeviceRequestSchema>;
export type VaultKind = z.infer<typeof vaultKindSchema>;
export type CreateVaultRequest = z.infer<typeof createVaultRequestSchema>;
export type UpdateVaultRequest = z.infer<typeof updateVaultRequestSchema>;
export type VaultSummary = z.infer<typeof vaultSummarySchema>;
export type ListVaultsResponse = z.infer<typeof listVaultsResponseSchema>;
export type Revision = z.infer<typeof revisionSchema>;
export type PushRevisionRequest = z.infer<typeof pushRevisionRequestSchema>;
export type ItemHeads = z.infer<typeof itemHeadsSchema>;
export type HeadsResponse = z.infer<typeof headsResponseSchema>;
export type HistoryResponse = z.infer<typeof historyResponseSchema>;
