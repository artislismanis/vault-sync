import { ChangeNotification, serverMessageSchema } from '@vault-sync/shared';

// Change-notification channel: WebSocket with backoff reconnect. Silent
// failure is acceptable — notifications are a latency optimization; periodic
// reconciliation guarantees correctness. Token travels as a query param
// (webviews can't set headers on WS connects).

const MAX_BACKOFF_MS = 60_000;

export class ChangeChannel {
  private socket: WebSocket | null = null;
  private backoffMs = 1_000;
  private closedByUs = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private serverUrl: string,
    private token: string,
    private vaultId: string,
    private onNotification: (message: ChangeNotification) => void,
  ) {}

  connect(): void {
    this.closedByUs = false;
    const wsUrl =
      this.serverUrl.replace(/^http/, 'ws').replace(/\/+$/, '') +
      `/ws?token=${encodeURIComponent(this.token)}`;
    try {
      this.socket = new WebSocket(wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket.onopen = () => {
      this.backoffMs = 1_000;
      this.socket?.send(JSON.stringify({ type: 'subscribe', vaultId: this.vaultId }));
    };
    this.socket.onmessage = (event) => {
      try {
        const parsed = serverMessageSchema.safeParse(JSON.parse(String(event.data)));
        if (parsed.success && parsed.data.type === 'changed') this.onNotification(parsed.data);
      } catch {
        // ignore malformed frames
      }
    };
    this.socket.onclose = () => this.scheduleReconnect();
    this.socket.onerror = () => this.socket?.close();
  }

  private scheduleReconnect(): void {
    if (this.closedByUs || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  disconnect(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }
}
