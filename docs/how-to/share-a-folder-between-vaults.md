# Share a folder between vaults

A **folder connection** mounts another server vault (a "shared vault") at a
folder in this vault. Use it for content you maintain in more than one
place — a reference library, a shared project — and want to stay identical
everywhere, without giving either vault the other's master passphrase.

Each folder connection is its own vault on the server: its own passphrase,
its own version history. Mounting the same shared vault in two Obsidian
vaults keeps that one folder in sync between them; everything else in each
vault stays completely separate.

## Set up the first side

In the vault that already has the content (or will):

1. Settings → **Connection** tab → **Folder connections** → **Create a new
   shared vault**.
2. Enter a name for the shared vault, a passphrase (this is separate from
   your main vault's passphrase — write it down, there's no recovery), and
   the local folder to sync, e.g. `Reference`.
3. Click **Create**. If the folder already has files in it, they upload to
   the new shared vault.

Creating a shared vault **immediately mounts it in this vault too** — the
originating vault is just the first mount, not a special "owner". The folder
now appears under **Folder connections**, and it can be disconnected and
reconnected here exactly like on any other vault.

## Connect the second vault

In the other vault:

1. Settings → **Connection** tab, log in with the same account, then
   **Folder connections** → pick the shared vault from the dropdown, enter
   its passphrase, and the local folder to use in *this* vault — it doesn't
   have to match the first vault's folder name, e.g. `Shared/Reference`.
2. Click **Connect**.

The dropdown lists only folder-share vaults (full vaults are opened from the
**Vault** section instead), and it refreshes automatically when you open
settings — a share created moments ago on another vault or device appears
without any manual step. There's still a **Refresh vault list** button if you
want to force it.

### If this vault already has its own copy of the folder

Nothing to do differently — existing files merge automatically, exactly
like a second device joining a vault:

- Identical files on both sides: no-op — including after you disconnect and
  later reconnect a folder whose files never changed. (Files that differ only
  by line endings or Unicode normalization also count as identical here.)
- The same file edited differently on each side (and it's a mergeable text
  file): merged automatically.
- Anything else that conflicts: both versions are kept — the newer one at
  the original path, the older one alongside as a "(conflict ...)" sibling.

Check the folder afterward and clean up any conflict files.

## Everyday use

Just edit files in the mounted folder like any other note — sync happens
automatically, same as the rest of the vault. Both vaults' copies of the
folder stay identical over time.

## Renaming or moving the mount folder

**Rename the folder from the connection's settings, not the file
explorer.** If Obsidian's file explorer deletes/recreates the folder (a
rename looks like that internally), vault-sync detects the folder is
missing and **pauses that connection** rather than guessing — you'll see a
"folder missing — sync paused" notice and status in settings. Nothing is
deleted on the server; recreate the folder (or fix the path in settings)
and sync resumes.

## Disconnecting

Settings → **Connection** tab → **Folder connections** → **Disconnect**.
This only forgets the connection on this device — your files stay exactly
where they are, and the shared vault on the server is untouched. Other
devices still connected to it are unaffected.

## Migrating a folder that was already syncing with your main vault

If `Reference/` was previously part of your ordinary whole-vault sync,
adding a folder connection at that path takes over syncing it going
forward. The **old** copies already on the server (under your main vault)
freeze in place — they stop receiving updates but are never deleted. You
can safely ignore them, or prune them later via the admin CLI
(`docs/reference/admin-cli.md`) once you've confirmed the folder connection
has everything. Disconnecting the folder connection later hands the folder
back to ordinary whole-vault sync automatically.

## Notes

- A folder connection can't overlap another one, and can't be `.obsidian` or
  inside it.
- `.obsidian` settings sync (see
  [sync-obsidian-settings.md](sync-obsidian-settings.md)) only applies to
  your main vault — a mounted shared vault never syncs `.obsidian` content,
  even if it happens to contain any.
- With more than one folder connection, syncs run one connection at a time
  — a brief latency cost, not a correctness one.
