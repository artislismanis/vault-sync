import { serverMessageSchema, ServerMessage } from '@vault-sync/shared';

// Change-notification channel: WebSocket with heartbeat + exponential-backoff
// reconnect, degrading silently to interval polling (VPNs, proxies, mobile).
// Notifications are a latency optimization only — reconciliation guarantees
// correctness, so a dropped connection never loses data.

export type NotificationHandler = (message: ServerMessage) => void;

export class ChangeChannel {
  private socket: WebSocket | null = null;

  constructor(
    private wsUrl: string,
    private onNotification: NotificationHandler,
  ) {}

  connect(): void {
    this.socket = new WebSocket(this.wsUrl);
    this.socket.onmessage = (event) => {
      const parsed = serverMessageSchema.safeParse(JSON.parse(String(event.data)));
      if (parsed.success) this.onNotification(parsed.data);
    };
    // TODO(sync-engine): heartbeats, backoff reconnect, polling fallback.
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = null;
  }
}
