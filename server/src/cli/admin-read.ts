import type { Config } from '../config';
import type { Db } from '../store/db';
import type { ObjectStore } from '../store/s3';
import { passwordHashSource } from '../store/account';

// Data gathering for the read-only admin commands (`status`, `vault-list`,
// `device-list`, `storage-usage`). Each returns plain data so the CLI can
// render it as a table / text for people or as JSON for scripts, and so it
// can be tested without spawning the CLI. Field names are the table columns.

/** Commands that accept `--json`. */
export const JSON_COMMANDS: readonly string[] = [
  'status',
  'vault-list',
  'device-list',
  'storage-usage',
];

export interface ParsedArgv {
  command: string | undefined;
  args: string[];
  json: boolean;
}

/** Split argv into command + args, pulling `--json` out from before or after the command. */
export function parseArgv(argv: string[]): ParsedArgv {
  const json = argv.includes('--json');
  const [command, ...args] = argv.filter((a) => a !== '--json');
  return { command, args, json };
}

const megabytes = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

export interface VaultRow {
  id: string;
  name: string | null;
  created_at: string;
}

export function listVaults(db: Db): VaultRow[] {
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

export function listDevices(db: Db): DeviceRow[] {
  return db
    .prepare('SELECT id, name, created_at, last_seen FROM device ORDER BY last_seen DESC')
    .all() as DeviceRow[];
}

export interface StorageUsageRow {
  vault: string;
  objects: number;
  megabytes: number;
}

export async function storageUsage(store: ObjectStore): Promise<StorageUsageRow[]> {
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
    megabytes: megabytes(bytes),
  }));
}

export interface StatusReport {
  version: string;
  bucket_reachable: boolean;
  /** Where the active password hash comes from. */
  auth: ReturnType<typeof passwordHashSource>;
  vaults: number;
  revisions: number;
  devices: number;
  /** Most recent device `last_seen`, or null when there are no devices. */
  last_seen: string | null;
  storage_bytes: number;
  storage_objects: number;
}

export async function collectStatus(
  version: string,
  config: Config,
  db: Db,
  store: ObjectStore,
): Promise<StatusReport> {
  const bucketOk = await store.checkBucket();
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
    bucket_reachable: bucketOk,
    auth: passwordHashSource(config.DATA_DIR, config.ACCOUNT_PASSWORD_HASH),
    vaults: vaults.n,
    revisions: revisions.n,
    devices: devices.n,
    last_seen: devices.latest,
    storage_bytes: blobBytes,
    storage_objects: blobObjects,
  };
}

/** The human-readable `status` screen. */
export function formatStatus(s: StatusReport): string[] {
  return [
    `vault-sync server ${s.version}`,
    `bucket:   ${s.bucket_reachable ? 'reachable' : 'UNREACHABLE — check S3_* settings'}`,
    s.auth === 'none'
      ? 'auth:     NO PASSWORD CONFIGURED — logins disabled'
      : `auth:     password hash from ${s.auth === 'file' ? 'account.json (set-password)' : 'env'}`,
    `vaults:   ${s.vaults} (${s.revisions} revision(s) total)`,
    `devices:  ${s.devices}${s.last_seen ? ` (last seen ${s.last_seen})` : ''}`,
    `storage:  ${megabytes(s.storage_bytes)} MB in ${s.storage_objects} blob object(s)`,
  ];
}
