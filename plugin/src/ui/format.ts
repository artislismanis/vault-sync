// Display formatting for the history UI. Pure module — no obsidian imports —
// so it stays unit-testable.

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** "just now" / "5 min ago" / "3 h ago" / "2 d ago"; locale date beyond 7 days. */
export function formatRelativeWhen(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)} d ago`;
  return then.toLocaleDateString();
}

export function deviceLabel(
  deviceId: string,
  ownDeviceId: string | null,
  names: Map<string, string>,
): string {
  if (deviceId === ownDeviceId) return 'this device';
  return names.get(deviceId) ?? 'unknown device';
}
