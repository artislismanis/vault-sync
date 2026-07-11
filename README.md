# Vault Sync

Self-hosted, end-to-end-encrypted sync for [Obsidian](https://obsidian.md)
vaults. A TypeScript sync server (Docker, S3-compatible storage) plus an
Obsidian plugin for desktop and mobile — aiming for rough feature parity with
Obsidian Sync, under your own control.

**Status: alpha.** Working: E2EE sync (desktop + mobile), three-way merge
with conflict files, delete propagation, chunked + resumable large-file
transfers, parallel transfers, selective sync (size cap + file-type
toggles), version history with restore, sync activity log, WebSocket push
with polling fallback. Not yet in the community plugin directory — install
via BRAT.

## Security model

The server stores only ciphertext: file contents, file names, and paths are
encrypted client-side (XChaCha20-Poly1305, Argon2id-derived keys) with a
per-vault passphrase that never leaves your devices. A compromised server or
bucket reveals sizes and edit timing, nothing more. There is **no passphrase
recovery** — lose it and the data is gone.

## Server

Docker image: `ghcr.io/artislismanis/vault-sync-server`. Needs any
S3-compatible store (MinIO, S3, R2, …) — or run the bundled-MinIO compose
profile. Full walkthrough (Synology NAS, reverse proxy, HTTPS):
[docs/deployment.md](docs/deployment.md).

## Plugin (via BRAT)

1. Install **BRAT** from Obsidian community plugins.
2. BRAT → "Add beta plugin" → `artislismanis/vault-sync`.
3. Enable **Vault Sync**, point it at your server, create or unlock a vault.

Works on desktop and mobile.

## Development

npm workspaces monorepo: `server/` (Fastify), `plugin/` (Obsidian, esbuild),
`shared/` (protocol schemas + crypto). See `CLAUDE.md` for commands and
`docs/` for the spec, sync protocol, architecture, and decision log.
