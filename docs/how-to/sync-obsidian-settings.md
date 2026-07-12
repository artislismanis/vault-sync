# Sync Obsidian settings between devices

Syncs the `.obsidian` folder — appearance, hotkeys, core and community
plugin settings, and optionally plugin code — end-to-end encrypted, with
full version history. Off by default; you enable it on each device that
should participate.

## Enable

On each device: Vault Sync settings → **Settings sync** tab → turn on
"Sync Obsidian settings on this device". Then pick categories (the
granularity matches Obsidian Sync's own vault-configuration options):

| Toggle | Covers | Notes |
|---|---|---|
| Main settings | `app.json` | Editor, files & links |
| Appearance | `appearance.json` | Theme choice, fonts, interface |
| Themes and snippets | `themes/`, `snippets/` | |
| Hotkeys | `hotkeys.json` | |
| Active core plugin list | `core-plugins.json` | |
| Core plugin settings | `graph.json`, `daily-notes.json`, any other config files | Default bucket — future Obsidian config files land here |
| Active community plugin list | `community-plugins.json` | |
| Community plugin settings | each plugin's `data.json` | May contain other plugins' API tokens; they're stored E2E-encrypted on your server |
| Installed community plugins | `main.js`, manifests, styles | Installed plugins follow you across devices. Synced code runs on this device; on mobile, usually leave this **off** (mobile wants different plugins) |

Never synced, on purpose: `workspace*` files (per-device window layout) and
Vault Sync's own plugin folder (it contains this device's credentials and
sync state).

## How changes apply

- Pulled settings changes take effect after you **reload Obsidian** — you'll
  get one notice per sync when config changed.
- Changes you make locally sync on the next periodic scan (within ~5
  minutes), on app foreground, or immediately with "Sync now". A setting
  changed right before quitting syncs on the next launch.

## When two devices disagree

Newest change wins, everywhere, automatically. Nothing is lost: the losing
version is kept in version history. To inspect or bring it back, run the
command **"Version history for a synced settings file"**, pick the file, and
use the preview/diff/restore view.

Joining a device that already has its own config: the side with the older
files gets replaced by the newer ones — the replaced versions are all in
history.

## Turning it off

Disabling the master toggle (or any category) stops updates in both
directions on that device. Nothing is deleted anywhere; re-enabling rejoins
through the normal sync path.
