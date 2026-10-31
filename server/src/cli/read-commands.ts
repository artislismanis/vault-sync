import type { Db } from '../store/db';
import type { ObjectStore } from '../store/s3';

// Data collectors for the read-only admin commands. They return plain data so
// the CLI can render it as a table/text for people or as JSON for scripts.

/** Commands that accept `--json`. */
export const JSON_COMMANDS: ReadonlySet<string> = new Set([
  'status',
  'vault-list',
  'device-list',
  'storage-usage',
]);

export interface ParsedArgs {
  command: string | undefined;
  args: string[];
  json: boolean;
}

/** `--json` is a global flag: accepted before or after the command name. */
export function parseArgs(argv: string[]): ParsedArgs {
  const json = argv.includes('--json');
  const [command, ...args] = argv.filter((arg) => arg !== '--json');
  return { command, args, json };
}

const toMegabytes = (bytes: number): number => Math.round((bytes / (1024 * 1024)) * 10) / 10;

export interface VaultRow {
  id: string;
  name: string | null;
  created_at: string;
}

export function collectVaultList(db: Db): VaultRow[] {
  return db
    .prepare('SELECT id, name, created_at FROM vault ORDER BY created_at')
    .all() as VaultRow[];
}

export interface DeviceRow {
  id: string;
  name: string;
  created_at: string;
  last_seen: string;
}

export function collectDeviceList(db: Db): DeviceRow[] {
  return db
    .prepare('SELECT id, name, created_at, last_seen FROM device ORDER BY last_seen DESC')
    .all() as DeviceRow[];
}

export interface StorageUsageRow {
  vault: string;
  objects: number;
  megabytes: number;
}

export async function collectStorageUsage(store: ObjectStore): Promise<StorageUsageRow[]> {
  const perVault = new Map<string, { bytes: number; objects: number }>();
  for (const obj of await store.listWithMeta('blobs/')) {
    const vaultId = obj.key.split('/')[1] ?? '?';
    const entry = perVault.get(vaultId) ?? { bytes: 0, objects: 0 };
    entry.bytes += obj.sizeBytes;
    entry.objects += 1;
    perVault.set(vaultId, entry);
  }
  return [...perVault.entries()].map(([vault, { bytes, objects }]) => ({
    vault,
    objects,
    megabytes: toMegabytes(bytes),
  }));
}

export interface StatusReport {
  version: string;
  bucketReachable: boolean;
  /** Where the active password hash comes from. */
  authSource: 'file' | 'env' | 'none';
  vaults: number;
  revisions: number;
  devices: number;
  lastSeen: string | null;
  storage: { megabytes: number; objects: number };
}

export async function collectStatus(
  db: Db,
  store: ObjectStore,
  version: string,
  authSource: StatusReport['authSource'],
): Promise<StatusReport> {
  const bucketReachable = await store.checkBucket();
  const vaults = db.prepare('SELECT COUNT(*) AS n FROM vault').get() as { n: number };
  const revisions = db.prepare('SELECT COUNT(*) AS n FROM revision').get() as { n: number };
  const devices = db
    .prepare('SELECT COUNT(*) AS n, MAX(last_seen) AS latest FROM device')
    .get() as { n: number; latest: string | null };
  let blobBytes = 0;
  let blobObjects = 0;
  for (const obj of await store.listWithMeta('blobs/')) {
    blobBytes += obj.sizeBytes;
    blobObjects++;
  }
  return {
    version,
    bucketReachable,
    authSource,
    vaults: vaults.n,
    revisions: revisions.n,
    devices: devices.n,
    lastSeen: devices.latest,
    storage: { megabytes: toMegabytes(blobBytes), objects: blobObjects },
  };
}

export function formatStatus(status: StatusReport): string[] {
  return [
    `vault-sync server ${status.version}`,
    `bucket:   ${status.bucketReachable ? 'reachable' : 'UNREACHABLE — check S3_* settings'}`,
    status.authSource === 'none'
      ? 'auth:     NO PASSWORD CONFIGURED — logins disabled'
      : `auth:     password hash from ${status.authSource === 'file' ? 'account.json (set-password)' : 'env'}`,
    `vaults:   ${status.vaults} (${status.revisions} revision(s) total)`,
    `devices:  ${status.devices}${status.lastSeen ? ` (last seen ${status.lastSeen})` : ''}`,
    `storage:  ${status.storage.megabytes} MB in ${status.storage.objects} blob object(s)`,
  ];
}

/** A script reading this must not mistake a dead bucket for a healthy server. */
export function statusJson(status: StatusReport): string {
  if (!status.bucketReachable) throw new Error('bucket unreachable — check S3_* settings');
  return JSON.stringify(status, null, 2);
}
