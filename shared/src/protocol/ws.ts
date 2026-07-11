import { z } from 'zod';
import { vaultIdSchema, itemIdSchema, deviceIdSchema } from './ids';

// WebSocket change-notification messages. Notifications carry ids only —
// clients react by pulling revision heads over REST, so a lost notification
// costs latency, never correctness (reconciliation is the safety net).

export const subscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  vaultId: vaultIdSchema,
});

export const changeNotificationSchema = z.object({
  type: z.literal('changed'),
  vaultId: vaultIdSchema,
  itemIds: z.array(itemIdSchema),
  originDeviceId: deviceIdSchema,
});

export const clientMessageSchema = z.discriminatedUnion('type', [subscribeMessageSchema]);
export const serverMessageSchema = z.discriminatedUnion('type', [changeNotificationSchema]);

export type SubscribeMessage = z.infer<typeof subscribeMessageSchema>;
export type ChangeNotification = z.infer<typeof changeNotificationSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
