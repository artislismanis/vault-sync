# Back up and restore the server

## What to back up

**The S3 bucket is the complete server state.** Every accepted write lands in
the bucket as a metadata sidecar + ciphertext blobs before it is
acknowledged, so "back up the bucket" backs up everything: vaults, files,
full version history. It contains only ciphertext — a leaked backup reveals
sizes and timing, not content.

The `vault-sync-data` volume (`DATA_DIR`) is *almost* expendable:

- `index.db` — a derived SQLite cache, rebuildable from the bucket.
- `account.json` — only exists if you've used `admin set-password`; losing it
  falls back to the `ACCOUNT_PASSWORD_HASH` env var (the original password).
  Include it in backups if you've changed the password and want the change to
  survive volume loss.

## Restore procedure

1. Restore the bucket (or point at the replica).
2. Start the container with the same env configuration.
3. Rebuild the index:

   ```sh
   docker compose exec vault-sync node dist/cli/admin.cjs rebuild-index
   ```

4. Devices log in again (login tokens are deliberately local-only state) and
   sync converges.

Verify with `admin status` — bucket reachable, expected vault and revision
counts ([../reference/admin-cli.md](../reference/admin-cli.md#status)).
