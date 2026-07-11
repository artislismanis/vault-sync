import { loadConfig } from '../config';
import { openDb } from '../store/db';
import { createObjectStore } from '../store/s3';
import { hashPassword } from '../auth';
import { rebuildIndex, revisionMetaKey } from '../store/metadata-log';
import { findPruneCandidates, pruneRevisions } from '../store/prune';

// Minimal admin CLI, run inside the container (`docker exec … node dist/admin.cjs`)
// or locally via `npm run -w server admin -- <command>`.

const USAGE = `usage: admin <command>

commands:
  hash-password <password>       print ACCOUNT_PASSWORD_HASH value for .env
  vault-list                     list vaults (ids + created_at; names are E2EE)
  rebuild-index                  rebuild the SQLite index from bucket sidecars
  gc-blobs [--older-hours N]     delete blob chunks stranded by crashed
                                 uploads (no revision sidecar; default 24h old)
  prune --older-days N [--vault ID] [--yes]
                                 delete non-head revisions older than N days
                                 (heads and tombstone heads always kept;
                                 prints a preview unless --yes)
  storage-usage                  per-vault blob storage totals
  device-list                    list registered devices/tokens
  device-revoke <deviceId>       revoke a device's token
`;

function argValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'hash-password': {
      const password = args[0];
      if (!password) throw new Error('usage: admin hash-password <password>');
      console.log(await hashPassword(password));
      return;
    }
    case 'vault-list': {
      const config = loadConfig();
      const db = openDb(config.DATA_DIR);
      const rows = db.prepare('SELECT id, created_at FROM vault ORDER BY created_at').all();
      console.table(rows);
      db.close();
      return;
    }
    case 'rebuild-index': {
      const config = loadConfig();
      const db = openDb(config.DATA_DIR);
      const result = await rebuildIndex(createObjectStore(config), db);
      console.log(
        `rebuilt index: ${result.vaults} vault(s), ${result.items} item(s), ${result.revisions} revision(s)`,
      );
      db.close();
      return;
    }
    case 'gc-blobs': {
      const olderHoursArg = args.indexOf('--older-hours');
      const olderHours = olderHoursArg === -1 ? 24 : Number(args[olderHoursArg + 1]);
      if (!Number.isFinite(olderHours) || olderHours < 0) {
        throw new Error('usage: admin gc-blobs [--older-hours N]');
      }
      const store = createObjectStore(loadConfig());
      const cutoff = Date.now() - olderHours * 3600 * 1000;

      // Group blob objects by (vaultId, revisionId); a group is an orphan if
      // its revision sidecar never landed (crashed/abandoned upload).
      const groups = new Map<string, { keys: string[]; newest: number }>();
      for (const obj of await store.listWithMeta('blobs/')) {
        const [, vaultId, revisionId] = obj.key.split('/');
        if (!vaultId || !revisionId) continue;
        const groupKey = `${vaultId}/${revisionId}`;
        const group = groups.get(groupKey) ?? { keys: [], newest: 0 };
        group.keys.push(obj.key);
        group.newest = Math.max(group.newest, obj.lastModified.getTime());
        groups.set(groupKey, group);
      }

      let removed = 0;
      let kept = 0;
      for (const [groupKey, group] of groups) {
        const [vaultId, revisionId] = groupKey.split('/') as [string, string];
        if (await store.exists(revisionMetaKey(vaultId, revisionId))) {
          kept++;
          continue;
        }
        if (group.newest > cutoff) {
          kept++; // possibly an in-flight upload — leave it alone
          continue;
        }
        for (const key of group.keys) await store.delete(key);
        console.log(`removed orphan ${groupKey} (${group.keys.length} object(s))`);
        removed++;
      }
      console.log(`gc-blobs: removed ${removed} orphan group(s), kept ${kept}`);
      return;
    }
    case 'prune': {
      const days = Number(argValue(args, '--older-days'));
      if (!Number.isFinite(days) || days <= 0) {
        throw new Error('usage: admin prune --older-days N [--vault ID] [--yes]');
      }
      const config = loadConfig();
      const db = openDb(config.DATA_DIR);
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const candidates = findPruneCandidates(db, cutoff, argValue(args, '--vault') ?? null);
      if (candidates.length === 0) {
        console.log('prune: nothing to remove');
      } else if (!args.includes('--yes')) {
        console.log(`prune: would remove ${candidates.length} non-head revision(s) older than ${cutoff}`);
        console.log('re-run with --yes to delete');
      } else {
        const result = await pruneRevisions(createObjectStore(config), db, candidates);
        console.log(`prune: removed ${result.revisions} revision(s), ${result.objects} object(s)`);
      }
      db.close();
      return;
    }
    case 'storage-usage': {
      const store = createObjectStore(loadConfig());
      const perVault = new Map<string, { bytes: number; objects: number }>();
      for (const obj of await store.listWithMeta('blobs/')) {
        const vaultId = obj.key.split('/')[1] ?? '?';
        const entry = perVault.get(vaultId) ?? { bytes: 0, objects: 0 };
        entry.bytes += obj.sizeBytes;
        entry.objects += 1;
        perVault.set(vaultId, entry);
      }
      console.table(
        [...perVault.entries()].map(([vault, { bytes, objects }]) => ({
          vault,
          objects,
          megabytes: Math.round((bytes / (1024 * 1024)) * 10) / 10,
        })),
      );
      return;
    }
    case 'device-list': {
      const config = loadConfig();
      const db = openDb(config.DATA_DIR);
      console.table(
        db.prepare('SELECT id, name, created_at, last_seen FROM device ORDER BY last_seen DESC').all(),
      );
      db.close();
      return;
    }
    case 'device-revoke': {
      const deviceId = args[0];
      if (!deviceId) throw new Error('usage: admin device-revoke <deviceId>');
      const config = loadConfig();
      const db = openDb(config.DATA_DIR);
      const result = db.prepare('DELETE FROM device WHERE id = ?').run(deviceId);
      console.log(result.changes === 1 ? `revoked ${deviceId}` : `no such device: ${deviceId}`);
      db.close();
      return;
    }
    default:
      console.error(USAGE);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
