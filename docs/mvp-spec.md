# MVP Specification

## Motivation

Obsidian Sync works well but costs money and is a closed box. The owner is a
tinkerer who wants: no subscription, full control over data, and a platform to
build vault-sync features Obsidian doesn't offer. Strategy: reach **rough
feature parity** with Obsidian Sync first (https://obsidian.md/help/sync is the
parity baseline), then iterate.

## Success criteria ("the MVP works")

- Two desktops and one phone converge on the same vault state without manual
  intervention; desktop↔desktop propagation feels near-instant, mobile syncs
  fully on app foreground.
- Edits made *outside* Obsidian on desktop (Claude Code, files dropped into the
  vault folder) sync like any other edit.
- Concurrent offline edits to the same note merge automatically when changes
  don't overlap; true collisions produce a conflict file, never data loss.
- Every synced revision is recoverable from version history.
- The server stores only ciphertext; compromise of the NAS/S3 bucket reveals no
  note content or file names.

## Personas & environment

- Single user, multiple vaults. Multi-user is explicitly out of scope for MVP
  (but avoid design choices that make it impossible later).
- Server: Docker container on a Synology NAS initially; must be host-generic so
  it can move to any cloud. Storage via S3-compatible API (MinIO on the NAS
  now, real S3/R2 later).
- Network: reached over home VPN (OpenVPN) or a reverse-proxied public HTTPS
  endpoint. Server itself listens on plain HTTP behind TLS termination.
- Clients: Obsidian plugin on desktop (Win/Mac/Linux) and mobile (iOS/Android).

## Phase 1 — MVP

| Area | Requirement |
|---|---|
| Sync engine | Whole-file sync of markdown + attachments; per-file versioning; delete propagation |
| Change detection | Obsidian vault events + startup reconciliation scan + periodic/watched rescan on desktop (external edits are first-class) |
| Transport | HTTPS REST for blobs/state + WebSocket push for change notifications, degrading gracefully to polling |
| Mobile behaviour | Full sync on app foreground; no reliance on background execution |
| E2EE | Client-side encryption of content AND paths; per-vault passphrase; server never sees plaintext or keys (see sync-protocol.md) |
| Conflict resolution | Client-side three-way merge for non-overlapping markdown edits; conflict file fallback; losing versions always preserved in history |
| Version history | Keep every revision by default; retention/pruning policy configurable per vault; restore any version from plugin UI with preview + diff and per-device attribution |
| Selective sync | Native formats (md, canvas, base) always sync; toggles for images/audio/video/PDF (Obsidian's accepted-extension lists) and all other types; max-file-size cap |
| Onboarding | Plugin settings: server URL + account password → pick existing vault or create one → enter/set E2EE passphrase → map to local folder |
| Vault status | Sync activity log + status indicator in plugin (parity: Obsidian's status icon/log) |
| Admin | Minimal CLI (create vault, reset password, storage usage). No web admin UI |
| Ops | Single Docker image + compose file (server + MinIO for dev); all persistent state in S3 buckets — backing up buckets backs up everything |

## Phase 2 — fast-follow (captured, not MVP-blocking)

- ~~`.obsidian` settings sync~~ — **implemented 2026-07-12**: per-device
  opt-in with category toggles (appearance / hotkeys / core / community
  plugin settings / plugin code), LWW-with-history conflict policy for
  config files (see decisions.md), canonical `.obsidian/` wire paths. Guide:
  `docs/how-to/sync-obsidian-settings.md`.
- ~~Folder connections (sync a folder between vaults)~~ — **implemented
  2026-07-12**: mount an additional server vault at a local folder, e.g. a
  `Reference/` folder shared between a personal and a work vault. Each
  connection is a dedicated vault (own passphrase/history); first connect
  join-merges existing content. Guide:
  `docs/how-to/share-a-folder-between-vaults.md`.
- Glob-style ignore patterns (include if trivially cheap during MVP; otherwise
  here).
- Chunked/delta upload for large binaries (slide decks etc. are expected in the
  vault; MVP accepts whole-file re-upload).
- QR-code / one-tap device pairing.
- Companion web client: read-only version lookup, history browsing, cleanup.
  It is just another E2EE client — the user supplies the key; no server-side
  decryption ever.

## Phase 3+ — ideas parking lot

- Multi-user / shared vaults, collaboration (distinct from folder
  connections above, which is one user mounting their own additional vaults —
  this item is about multiple *people* sharing access)
- Headless CLI sync client
- Server-assisted housekeeping that works on ciphertext (orphan GC, quota)

## Explicit non-goals (MVP)

- No multi-user auth, no cross-user sharing, no server-side rendering/search
  of content
- No custom mobile app — the Obsidian plugin is the only client
- No Synology-specific integration
- No server-side merge (impossible under E2EE by design)
