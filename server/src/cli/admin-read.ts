import type { Db } from '../store/db';
import type { ObjectStore } from '../store/s3';

// Data behind the read-only admin commands (status, vault-list, device-list,
// storage-usage). Shared by the human tables and `--json` so both always show
// the same fields. No console output here.

/** Commands that accept --json. */
export const JSON_COMMANDS: readonly string[] = [
  'status',
  'vault-list',
  'device-list',
  'storage-usage',
];

/** Strip every `--json` token so it works before or after the command name. */
export function extractJsonFlag(argv: string[]): { json: boolean; argv: string[] } {
  const rest = argv.filter((arg) => arg !== '--json');
  return { json: rest.length !== argv.length, argv: rest };
}

export function toMegabytes(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

export function listVaults(db: Db): { id: string; name: string | null; created_at: string }[] {
  return db.prepare('SELECT id, name, created_at FROM vault ORDER BY created_at').all() as {
    id: string;
    name: string | null;
    created_at: string;
  }[];
}

export function listDevices(
  db: Db,
): { id: string; name: string; created_at: string; last_seen: string }[] {
  return db
    .prepare('SELECT id, name, created_at, last_seen FROM device ORDER BY last_seen DESC')
    .all() as { id: string; name: string; created_at: string; last_seen: string }[];
}

export async function storageUsage(
  store: ObjectStore,
): Promise<{ vault: string; objects: number; megabytes: number }[]> {
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

export type PasswordSource = 'file' | 'env' | 'none';

export interface StatusReport {
  version: string;
  bucket: 'reachable' | 'unreachable';
  auth: PasswordSource;
  vaults: number;
  revisions: number;
  devices: number;
  last_seen: string | null;
  blob_objects: number;
  blob_megabytes: number;
}

export async function collectStatus(
  db: Db,
  store: ObjectStore,
  version: string,
  auth: PasswordSource,
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
    bucket: bucketOk ? 'reachable' : 'unreachable',
    auth,
    vaults: vaults.n,
    revisions: revisions.n,
    devices: devices.n,
    last_seen: devices.latest,
    blob_objects: blobObjects,
    blob_megabytes: toMegabytes(blobBytes),
  };
}
