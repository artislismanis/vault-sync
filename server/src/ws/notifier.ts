import type { WebSocket } from 'ws';
import type { ChangeNotification } from '@vault-sync/shared';

// Per-vault fan-out of change notifications. Delivery is best-effort: clients
// treat notifications as a latency optimization; reconciliation guarantees
// correctness (see shared/src/protocol/ws.ts).

export class Notifier {
  private subscribers = new Map<string, Set<WebSocket>>();

  subscribe(vaultId: string, socket: WebSocket): void {
    let set = this.subscribers.get(vaultId);
    if (!set) {
      set = new Set();
      this.subscribers.set(vaultId, set);
    }
    set.add(socket);
    socket.on('close', () => {
      set.delete(socket);
      if (set.size === 0) this.subscribers.delete(vaultId);
    });
  }

  notify(notification: ChangeNotification): void {
    const payload = JSON.stringify(notification);
    for (const socket of this.subscribers.get(notification.vaultId) ?? []) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }
}
