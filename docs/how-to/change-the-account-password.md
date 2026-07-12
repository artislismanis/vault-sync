# Change the account password

The account password is what devices use to log in (it is NOT the vault
passphrase — that encrypts your data and cannot be changed this way).

1. Run, on the host where the server runs:

   ```sh
   echo 'your-new-password' | docker compose exec -T vault-sync \
     node dist/cli/admin.cjs set-password --stdin
   ```

2. Done — no restart. The new password applies to the next login.

What to know:

- The hash is stored in `DATA_DIR/account.json`, which **overrides** the
  `ACCOUNT_PASSWORD_HASH` env var from now on. The env var stays as it was —
  it's the fallback if the data volume is ever lost. You can update it to
  match at your next redeploy if you want them consistent.
- Devices that are already logged in **stay logged in** — login tokens are
  independent of the password. To force a device out, revoke it:
  see [manage-devices.md](manage-devices.md).
- Verify which source is live with `admin status`
  ([../reference/admin-cli.md](../reference/admin-cli.md#status)).
