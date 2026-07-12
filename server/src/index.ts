import { loadConfig } from './config';
import { openDb } from './store/db';
import { createObjectStore } from './store/s3';
import { passwordHashSource, resolvePasswordHash } from './store/account';
import { buildApp } from './app';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config.DATA_DIR);
  const store = createObjectStore(config);
  const app = await buildApp({ config, db, store });

  const source = passwordHashSource(config.DATA_DIR, config.ACCOUNT_PASSWORD_HASH);
  const hash = resolvePasswordHash(config.DATA_DIR, config.ACCOUNT_PASSWORD_HASH);
  if (source === 'none') {
    app.log.warn(
      'no account password configured (env or admin set-password) — logins are disabled',
    );
  } else if (!hash!.startsWith('scrypt:')) {
    app.log.warn(
      `account password hash (from ${source}) looks malformed (expected "scrypt:...") — regenerate with the admin hash-password command`,
    );
  } else {
    app.log.info(
      `account password hash: from ${source === 'file' ? 'DATA_DIR/account.json (set-password)' : 'env'}`,
    );
  }

  const shutdown = async () => {
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
