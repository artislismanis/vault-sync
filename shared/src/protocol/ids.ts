import { z } from 'zod';

// Branded id types so a VaultId can't be passed where an ItemId is expected.
// Ids are server-generated UUIDs and carry no user information.

export const vaultIdSchema = z.uuid().brand<'VaultId'>();
export const itemIdSchema = z.uuid().brand<'ItemId'>();
export const revisionIdSchema = z.uuid().brand<'RevisionId'>();
export const deviceIdSchema = z.uuid().brand<'DeviceId'>();

export type VaultId = z.infer<typeof vaultIdSchema>;
export type ItemId = z.infer<typeof itemIdSchema>;
export type RevisionId = z.infer<typeof revisionIdSchema>;
export type DeviceId = z.infer<typeof deviceIdSchema>;
