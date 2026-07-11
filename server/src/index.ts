import { loadConfig } from './config';
import { openDb } from './store/db';
import { createObjectStore } from './store/s3';
import { buildApp } from './app';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config.DATA_DIR);
  const store = createObjectStore(config);
  const app = await buildApp({ config, db, store });

  if (!config.ACCOUNT_PASSWORD_HASH) {
    app.log.warn('ACCOUNT_PASSWORD_HASH not set — logins are disabled');
  } else if (!config.ACCOUNT_PASSWORD_HASH.startsWith('scrypt:')) {
    app.log.warn(
      'ACCOUNT_PASSWORD_HASH looks malformed (expected "scrypt:...") — regenerate with the admin hash-password command',
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
