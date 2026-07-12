# Delete a vault from the server

Removes a vault's entire server-side footprint: metadata, all revisions, all
ciphertext blobs. **This is permanent** — there is no trash. Local copies of
the files on your devices are not touched.

## From the plugin (connected vault)

The quickest path if the vault is connected on a device and you know its
passphrase. In plugin settings → **Connection** tab → **Manage vault**:

- **Delete vault** — enter the passphrase, type the vault name (or `delete`) to
  confirm, then confirm the second prompt. This deletes the server vault and
  disconnects the device locally; your files stay in the Obsidian vault.

The same section also offers **Disconnect** (stop syncing on this device, no
passphrase, reversible by re-unlocking), **Rename**, and **Change passphrase**.

Passphrase-gating means a vault whose passphrase is lost can't be deleted from
the plugin — use the admin CLI below.

## From the admin CLI

Use this to delete a vault nobody has connected, or one whose passphrase is lost.

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
