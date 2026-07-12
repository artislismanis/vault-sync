import { version as SERVER_VERSION } from '../../package.json';
import { loadConfig } from '../config';
import { openDb } from '../store/db';
import { createObjectStore } from '../store/s3';
import { hashPassword } from '../auth';
import { deleteVault, rebuildIndex, revisionMetaKey, vaultMetaKey } from '../store/metadata-log';
import { findPruneCandidates, pruneRevisions } from '../store/prune';
import { passwordHashSource, writeStoredPasswordHash } from '../store/account';

// Minimal admin CLI, run inside the container (`docker exec … node dist/admin.cjs`)
// or locally via `npm run -w server admin -- <command>`.

const USAGE = `usage: admin <command>

commands:
  status                         one-screen overview: version, bucket, auth,
                                 vaults, devices, storage
  set-password [password] [--stdin]
                                 change the account password (persists to
                                 DATA_DIR/account.json, which overrides the
                                 env hash; takes effect on next login, no
                                 restart needed). --stdin reads the password
                                 from stdin to keep it out of shell history
  hash-password <password>       print ACCOUNT_PASSWORD_HASH value for .env
  vault-list                     list vaults (ids + created_at; names are E2EE)
  vault-delete <vaultId> [--yes] PERMANENTLY delete a vault: all metadata,
                                 blobs, and index rows (preview unless --yes)
  rebuild-index                  rebuild the SQLite index from bucket sidecars
  gc-blobs [--older-hours N]     delete blob chunks stranded by crashed
                                 uploads (no revision sidecar; default 24h old)
  prune --older-days N [--vault ID] [--yes]
                                 delete non-head revisions older than N days
                                 (heads and tombstone heads always kept;
                                 prints a preview unless --yes)
  storage-usage                  per-vault blob storage totals
  device-list                    list registered devices/tokens
  device-rename <deviceId> <newName>
                                 rename a device (as shown in version history)
  device-revoke <deviceId>       revoke a device's token
`;

async function readLineFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split('\n')[0]!.trim();
}

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
    case 'set-password': {
      const password = args.includes('--stdin') ? await readLineFromStdin() : args[0];
      if (!password) throw new Error('usage: admin set-password [password] [--stdin]');
      const config = loadConfig();
      writeStoredPasswordHash(config.DATA_DIR, await hashPassword(password));
      console.log('password updated (DATA_DIR/account.json now overrides the env hash)');
      console.log('takes effect on the next login — no restart needed');
      console.log('already-logged-in devices stay logged in; evict with device-revoke');
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
        console.log(
          `prune: would remove ${candidates.length} non-head revision(s) older than ${cutoff}`,
        );
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
        db
          .prepare('SELECT id, name, created_at, last_seen FROM device ORDER BY last_seen DESC')
          .all(),
      );
      db.close();
      return;
    }
    case 'device-rename': {
      const [deviceId, newName] = args;
      if (!deviceId || !newName) throw new Error('usage: admin device-rename <deviceId> <newName>');
      // Same bound as the login/rename protocol schemas.
      if (newName.length > 64) throw new Error('device name must be 64 characters or fewer');
      const config = loadConfig();
      const db = openDb(config.DATA_DIR);
      const row = db.prepare('SELECT name FROM device WHERE id = ?').get(deviceId) as
        { name: string } | undefined;
      if (!row) {
        console.log(`no such device: ${deviceId}`);
      } else {
        db.prepare('UPDATE device SET name = ? WHERE id = ?').run(newName, deviceId);
        console.log(`renamed ${deviceId}: "${row.name}" → "${newName}"`);
      }
      db.close();
      return;
    }
    case 'vault-delete': {
      const vaultId = args[0];
      if (!vaultId || vaultId.startsWith('--')) {
        throw new Error('usage: admin vault-delete <vaultId> [--yes]');
      }
      const config = loadConfig();
      const db = openDb(config.DATA_DIR);
      const store = createObjectStore(config);
      const vault = db.prepare('SELECT created_at FROM vault WHERE id = ?').get(vaultId) as
        { created_at: string } | undefined;
      if (!vault && !(await store.exists(vaultMetaKey(vaultId)))) {
        console.log(`no such vault: ${vaultId}`);
        db.close();
        return;
      }
      if (!args.includes('--yes')) {
        const items = db
          .prepare('SELECT COUNT(*) AS n FROM item WHERE vault_id = ?')
          .get(vaultId) as { n: number };
        const revisions = db
          .prepare(
            'SELECT COUNT(*) AS n FROM revision WHERE item_id IN (SELECT id FROM item WHERE vault_id = ?)',
          )
          .get(vaultId) as { n: number };
        let blobBytes = 0;
        for (const obj of await store.listWithMeta(`blobs/${vaultId}/`)) {
          blobBytes += obj.sizeBytes;
        }
        console.log(`vault ${vaultId} (created ${vault?.created_at ?? 'unknown'}):`);
        console.log(
          `  ${items.n} file(s), ${revisions.n} revision(s), ${Math.round((blobBytes / (1024 * 1024)) * 10) / 10} MB of blobs`,
        );
        console.log('this PERMANENTLY deletes all of it — re-run with --yes to proceed');
      } else {
        const result = await deleteVault(store, db, vaultId);
        console.log(
          `deleted vault ${vaultId}: ${result.revisions} revision(s), ${result.objects} object(s)`,
        );
      }
      db.close();
      return;
    }
    case 'status': {
      const config = loadConfig();
      const db = openDb(config.DATA_DIR);
      const store = createObjectStore(config);
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
      console.log(`vault-sync server ${SERVER_VERSION}`);
      console.log(`bucket:   ${bucketOk ? 'reachable' : 'UNREACHABLE — check S3_* settings'}`);
      const source = passwordHashSource(config.DATA_DIR, config.ACCOUNT_PASSWORD_HASH);
      console.log(
        source === 'none'
          ? 'auth:     NO PASSWORD CONFIGURED — logins disabled'
          : `auth:     password hash from ${source === 'file' ? 'account.json (set-password)' : 'env'}`,
      );
      console.log(`vaults:   ${vaults.n} (${revisions.n} revision(s) total)`);
      console.log(
        `devices:  ${devices.n}${devices.latest ? ` (last seen ${devices.latest})` : ''}`,
      );
      console.log(
        `storage:  ${Math.round((blobBytes / (1024 * 1024)) * 10) / 10} MB in ${blobObjects} blob object(s)`,
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
