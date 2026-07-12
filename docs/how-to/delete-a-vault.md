# Delete a vault from the server

Removes a vault's entire server-side footprint: metadata, all revisions, all
ciphertext blobs. **This is permanent** — there is no trash. Local copies of
the files on your devices are not touched.

1. Find the vault id. Names are end-to-end encrypted, so the server can't
   show them — get the id from the device that uses the vault: plugin
   settings → "Copy vault ID" next to the connected vault's name. Or list
   ids and match by creation date:

   ```sh
   docker compose exec vault-sync node dist/cli/admin.cjs vault-list
   ```

2. Preview what would be deleted (safe, read-only):

   ```sh
   docker compose exec vault-sync node dist/cli/admin.cjs vault-delete <vaultId>
   ```

3. If the numbers look right, delete:

   ```sh
   docker compose exec vault-sync node dist/cli/admin.cjs vault-delete <vaultId> --yes
   ```

4. On devices that synced this vault, disconnect it in plugin settings
   (or connect them to another vault).

If the command is interrupted mid-delete, just re-run it — the deletion order
is crash-safe and the vault stays listed until fully gone.
