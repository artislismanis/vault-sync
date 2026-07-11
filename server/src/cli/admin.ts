import { loadConfig } from '../config';
import { openDb } from '../store/db';
import { createObjectStore } from '../store/s3';
import { hashPassword } from '../auth';
import { rebuildIndex } from '../store/metadata-log';

// Minimal admin CLI, run inside the container (`docker exec … node dist/admin.cjs`)
// or locally via `npm run -w server admin -- <command>`.

const USAGE = `usage: admin <command>

commands:
  hash-password <password>   print ACCOUNT_PASSWORD_HASH value for .env
  vault-list                 list vaults (ids + created_at; names are E2EE)
  rebuild-index              rebuild the SQLite index from bucket sidecars
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
      console.log(`rebuilt index: ${result.vaults} vault(s)`);
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
