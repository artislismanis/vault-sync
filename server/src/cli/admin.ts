import { loadConfig } from '../config';
import { openDb } from '../store/db';
import { createObjectStore } from '../store/s3';
import { hashPassword } from '../auth';
import { rebuildIndex, revisionMetaKey } from '../store/metadata-log';

// Minimal admin CLI, run inside the container (`docker exec … node dist/admin.cjs`)
// or locally via `npm run -w server admin -- <command>`.

const USAGE = `usage: admin <command>

commands:
  hash-password <password>       print ACCOUNT_PASSWORD_HASH value for .env
  vault-list                     list vaults (ids + created_at; names are E2EE)
  rebuild-index                  rebuild the SQLite index from bucket sidecars
  gc-blobs [--older-hours N]     delete blob chunks stranded by crashed
                                 uploads (no revision sidecar; default 24h old)
`;

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
    default:
      console.error(USAGE);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
