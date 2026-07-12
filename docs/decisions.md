# Decision Log

Append-only. One entry per significant decision: date, decision, why, and
what it rules out. Claude Code: add an entry whenever a meaningful choice is
made or an earlier one is revised — never silently contradict this file.

---

**2026-07-11 — Build self-hosted Obsidian Sync replacement, parity-first.**
Why: cost, data control, tinkering/extensibility. Rules out: chasing novel
features before rough parity (sync, selective sync, E2EE, conflicts, history).

**2026-07-11 — TypeScript for server and plugin; shared protocol package.**
Why: plugin must be TS/JS anyway; one schema definition for both sides;
ecosystem coverage. Rules out: Python/Go/Rust server for now.

**2026-07-11 — Docker deployment, Synology NAS first, host-generic.**
Why: easy NAS deploy today, low-friction move to cloud later. Rules out:
Synology-specific code paths.

**2026-07-11 — S3-compatible object storage as the only persistence target.**
Why: MinIO already on NAS; direct path to cloud object storage; "back up the
bucket" = full backup. Rules out: server designs requiring a local database as
unrecoverable source of truth.

**2026-07-11 — Single user, multiple vaults.**
Why: personal use. Multi-user deferred; avoid decisions that preclude it.

**2026-07-11 — Full E2EE; server never sees plaintext content, paths, or keys.**
Why: gold-standard privacy; owner accepts the costs. Consequences accepted:
no server-side merge/diff/dedup/search; version history is opaque blobs;
future web client must be given the key by the user.

**2026-07-11 — Client-side conflict resolution: three-way merge, conflict-file
fallback, never silent loss.** Why: matches Obsidian Sync behaviour; forced by
E2EE anyway. Requires clients to keep base versions for merge.

**2026-07-11 — Whole-file sync in MVP; chunking/delta deferred.**
Why: simplicity; notes are small. Large binaries (slide decks) accepted as
whole-file re-uploads for now; revisit with chunked upload in phase 2.

**2026-07-11 — WebSocket push with polling fallback; mobile syncs on
foreground.** Why: instant desktop↔desktop feel; realism about mobile OS
background limits and reverse-proxy/VPN flakiness.

**2026-07-11 — Version history: keep everything by default, retention
configurable per vault.** Why: storage is owner's; safety net preferred;
pruning works on ciphertext via the revision DAG.

**2026-07-11 — External edits are first-class (Claude Code, OS file drops).**
Why: owner's actual workflow. Requires reconciliation scans + desktop file
watching, not just Obsidian vault events.

**2026-07-11 — Settings sync (.obsidian) targeted as first fast-follow, not
MVP-blocking.** Why: owner wants it (desktop-focused) but agreed to triage;
device-specific config makes it fiddly. Glob ignores: include in MVP only if
cheap.

**2026-07-11 — Onboarding: server URL + password → pick/create vault → E2EE
passphrase → local folder.** Why: simple, matches Obsidian Sync flow. QR
pairing deferred.

**2026-07-11 — Network exposure is the owner's choice (OpenVPN or existing
reverse proxy); server is transport-agnostic HTTP behind TLS termination.**

**2026-07-11 — Admin surface: minimal CLI only (vaults, password reset,
usage).** Why: single user; avoid building UI nobody needs yet.

**2026-07-11 — AEAD: XChaCha20-Poly1305 via libsodium-wasm (sumo build); no
WebCrypto AES-GCM.** Why: Argon2id isn't in WebCrypto, so libsodium ships
regardless — AES-GCM would mean two crypto stacks; 192-bit nonces make random
nonces unconditionally safe with no cross-device counter state (GCM's 96-bit
nonces are a birthday liability under keep-every-revision); libsodium's wasm
is base64-embedded in JS, satisfying the plugin's single-file mobile bundle.
Rules out: dual crypto providers, nonce-counter coordination. Concedes
hardware-accelerated AES throughput — irrelevant at note scale.

**2026-07-11 — Envelope encryption from day one: random vault master key
(VMK) wrapped by Argon2id-derived KEK.** Why: passphrase change becomes a
32-byte re-wrap instead of re-encrypting the vault; authenticated unwrap IS
the wrong-passphrase check (fails closed by construction, no known-value
blob). Full VMK rotation stays re-encrypt-everything, documented as the
expensive escape hatch. Rules out: deriving content keys directly from the
passphrase (rejects sync-protocol.md's earlier "acceptable MVP answer").

**2026-07-11 — Vault names are E2EE like everything else.** Server and admin
CLI see only vault id/created_at/usage; the plugin (key holder) shows names.
Why: trust model says no names; a vault name is genuinely revealing; no
week-one exceptions to hard rule 1. Rules out: CLI vault rename (client-side
operation instead).

**2026-07-11 — Blobs keyed by revision id; no content addressing.** Why:
random-nonce E2EE makes ciphertext dedup ~nil; 1:1 blob↔revision keeps
retention pruning trivial (no refcounts/GC). Also deliberately rules out
convergent encryption — it leaks plaintext-equality to the server.

**2026-07-11 — Metadata: write-ahead JSON sidecars in the bucket + SQLite as
a rebuildable local index.** Every accepted write: PUT immutable sidecar →
update SQLite → ack; `admin rebuild-index` reconstructs the index from a
bucket scan. Why: "back up the bucket = complete backup" holds exactly, with
no snapshot-lag loss window; SQLite gives transactions and cheap DAG queries.
Rules out: periodic-snapshot persistence, pure-S3 live store. Note:
better-sqlite3 today; `node:sqlite` is a cheap future swap (removes the only
native dep) since the DB is expendable.

**2026-07-11 — Merge base cache: hybrid.** Base plaintext cached in plugin
data dir for merge-eligible text files ≤1 MB; hash + revision id only for
binaries/oversized; server fetch-and-decrypt fallback. Why: offline edits are
the common conflict case and must merge without connectivity; binaries never
text-merge; the device already holds the vault in plaintext so this is no
security regression. Rules out: re-fetch-only (breaks offline merge) and
unconditional caching (2× storage on attachment-heavy mobile vaults).

**2026-07-11 — diff3 library: node-diff3, wrapped in
`plugin/src/merge/diff3.ts`.** Why: only maintained pure-JS option with true
diff3 semantics; line granularity matches conflict-file UX. Rules out:
diff-match-patch (archived; fuzzy patching can silently misplace hunks —
hostile to never-lose-data) and jsdiff (no three-way merge).

**2026-07-11 — Newly-excluded synced files: stop updating (match Obsidian
Sync).** Sync index marks them `excluded`; delete propagation suppressed both
directions; re-inclusion goes through the normal merge/conflict path. Why: a
settings toggle must never destroy data on other devices. Rules out:
delete-remote, and server-visible exclusion state (client-side policy only).

**2026-07-11 — No CRDTs in MVP; revision DAG leaves the door open.** Why:
external edits arrive as plain files with no op history — CRDT ops would be
synthesized by diffing, i.e. the problem diff3 already solves; the filesystem
must stay the single source of truth; single-user offline-concurrent sync is
three-way merge's sweet spot. Door open: a future revision type can carry
encrypted CRDT (e.g. Yjs) updates as a per-file merge strategy for
in-Obsidian markdown edits, diff3 fallback for external edits.

**2026-07-11 — Push protocol: client-generated revision ids, blob uploaded
before metadata.** Client mints the revision UUID, PUTs the ciphertext blob,
then POSTs revision metadata; the server verifies the blob exists before
accepting (tombstones exempt). Why: makes uploads idempotent-retryable and
guarantees no accepted revision ever lacks its content; orphan blobs from
crashed pushes are harmless garbage (GC later). Rules out: server-minted ids,
multipart metadata+content uploads.

**2026-07-11 — Session tokens are ephemeral local state, deliberately NOT in
the bucket.** Stored hashed (SHA-256) in the SQLite index only; losing the
index forces re-login and nothing else. Why: tokens are re-derivable
credentials, not data; keeping them out of backups shrinks what a stolen
backup yields. WS authenticates via `?token=` query param (webviews can't set
WS headers).

**2026-07-11 — Plugin persists the unwrapped VMK, never the passphrase.**
Stored base64 in plugin data after unlock. Why: re-running 64 MiB Argon2id on
every mobile cold start costs seconds; the device already holds the whole
vault in plaintext, so a locally cached VMK adds no exposure. Content, path,
and MAC keys are derived per-purpose from the VMK via crypto_kdf (BLAKE2b,
distinct contexts).

**2026-07-11 — Conflict semantics: edits beat deletes in both directions;
concurrent heads are merged by the next client that sees them.** Local edit
vs remote tombstone → push resurrects; local delete vs remote edit → pull
restores. Multi-head DAG states are collapsed by a merge revision citing all
heads (diff3 when text+base allows, otherwise newest head keeps the path and
the rest become conflict siblings — nothing discarded). Local deletes applied
from remote tombstones go to the vault-local trash, not hard deletion.

**2026-07-11 — Distribution: public GitHub repo; bare-semver tags release
both artifacts; BRAT is the plugin channel for now.** One tag (`x.y.z`, no
`v`, must equal plugin manifest version) drives GitHub Actions to publish the
plugin release assets (main.js/manifest.json/styles.css — what BRAT consumes)
AND push `ghcr.io/artislismanis/vault-sync-server:<version>` + `:latest`.
Why: public is safe under E2EE (secrets live only in `.env`), BRAT gives
one-tap updates on mobile, single version stream keeps plugin/server pairing
obvious. Rules out: community-plugin submission for now; private-repo BRAT
tokens on every device.

**2026-07-11 — Blob format v2: chunked crypto_secretstream, one S3 object per
8 MiB chunk; whole-file AEAD retired for content.** Why: a 500 MB file OOM'd
mobile — whole-buffer seal holds plaintext+ciphertext+wasm copies (~3×) and
giant request bodies; chunking bounds crypto/transport at O(chunk) on both
ends (server bodyLimit now 16 MB). Secretstream's ratchet + per-revision AD +
mandatory FINAL tag give ordering, splice, and truncation protection.
Per-chunk objects chosen over S3 multipart: no assembly lifecycle, pruning is
a prefix delete, and clients can't use ranged GETs anyway (decryption is
chunk-framed). Client-generated revision ids retained; stranded chunks from
crashed uploads are swept by `admin gc-blobs`. Compat cliff accepted pre-1.0:
the server rejects unchunked pushes (old plugins must upgrade); v1 blobs stay
readable. Honest limit, documented: Obsidian's vault API is whole-file, so a
synced file still costs ~1× its size in client memory — full streaming is
impossible without Obsidian API changes.

**2026-07-11 — Selective-sync size cap implemented as the mobile OOM guard:
default 100 MB on mobile, unlimited on desktop, per-device setting.**
Oversized files (either side) become `excluded` index entries — stop-updating
semantics, never delete; raising the cap re-includes via the normal
merge/conflict path. Why: chunking raises the ceiling but can't remove the
whole-file floor (above); the cap is the designed answer for files beyond a
device's memory, matching Obsidian Sync's size-cap behaviour.

**2026-07-11 — Retention pruning is a manual admin CLI for MVP
(`prune --older-days N [--vault ID] [--yes]`), preview-by-default.** Removes
only non-head revisions (heads and tombstone heads are unconditionally
protected) — blobs, sidecars, and index rows — operating purely on the
ciphertext DAG. Dangling parent ids in surviving children are harmless
(heads computation is reference-based). Why manual: keep-everything is the
safe default, storage is the owner's, and a scheduled policy engine
(N days → daily → weekly) can layer on later without protocol changes.

**2026-07-11 — Session tokens never expire; revocation is explicit
(`device-list` / `device-revoke`).** Why: single user on private
infrastructure; forced re-auth on a phone mid-hike is worse than the threat
model warrants. Tokens are stored hashed; a stolen index file still yields
nothing usable. Revisit if multi-user ever lands.

**2026-07-11 — Convergence property tests are part of the test suite.**
Seeded random offline-edit sequences across 3 simulated clients (real
planner, real diff3 merge, real crypto, real server via inject) must
converge to identical vault state every round, with concurrent-head
collapse and conflict siblings included. Failures reproduce from the
logged seed. This is the regression net under any future planner change.

**2026-07-11 — Version history restore = write old content locally, push as
a new revision citing the current head.** Never a server-side rewrite: the
pre-restore state remains one step back in the DAG, so restore is itself
undoable (hard rule 4 applied to history). Tombstoned revisions are listed
but not directly restorable — restore any earlier content revision instead.
History UI: file menu + command → modal (date, size, device, restore).

**2026-07-11 — Mobile reliability: sync on visibilitychange (foreground) and
60 s polling fallback whenever the WebSocket is down.** WS remains the
latency path; polling guarantees convergence behind proxies/VPNs that break
WS. Both piggyback on the debounced single-flight engine, so overlapping
triggers coalesce.

**2026-07-11 — Selective sync category toggles (image/audio/video/pdf/other)
reuse the size-cap exclusion machinery; notes are never excludable.**
Client-side stop-updating semantics, identical to the size cap: disabling a
category never deletes anything anywhere; re-enabling rejoins files through
the normal merge/conflict path. Category exclusions log without toasts (a
chosen setting isn't a surprise); size exclusions still notify.

**2026-07-11 — Resumable large downloads via a ciphertext spool; parallel
transfers with a single-large-transfer rule.** Downloads >32 MB spool
ciphertext chunks to the plugin dir as they arrive: an interrupted pull
(mobile app kill, network drop) resumes by fetching only missing chunks, and
the whole-file plaintext buffer now exists only during final recompose —
same peak, drastically shorter memory high-water window. Spools are cleared
on success, on authentication failure (never resume corrupt data), and when
their revision stops being a head. Transfers run through a worker pool
(setting, 1–6; default 4 desktop / 2 mobile) with small-files-first ordering
and at most ONE >32 MB transfer in flight — peak memory stays bounded at
~parallel×32 MB + one large file. Merges stay sequential. NOT changed:
uploads still read whole files (Obsidian API floor) and recompose still
allocates the full file once — the size cap remains the mobile ceiling
guard. Spooling ciphertext locally adds no exposure (it is exactly what the
server stores).

**2026-07-11 — Account credential stays a pre-provisioned env hash for now;
first-boot setup deferred.** Owner reviewed the friction and chose to keep
it: single user, no user DB, and the env carries only the scrypt hash (safe
to expose in Portainer/inspect/backups) — the manual `hash-password` step is
the stand-in for a registration flow. Revisit trigger: if provisioning
annoys, add first-boot `SETUP_PASSWORD` (or `admin set-password`) persisting
the hash to the bucket. Rules out: plaintext passwords in env/config.

**2026-07-11 — Deploy compose is tool-agnostic: interpolation variables +
named volumes, no env_file, no relative binds; password hash uses ':' not
'$'.** Why: Portainer stacks have no working directory for `env_file:`/`./`
paths (real failure on the owner's NAS: "env file /data/compose/24/.env not
found"), while `${VAR}` interpolation is fed natively by the docker CLI
(.env), Portainer's env-vars UI, and Container Manager alike; crypt-style
`$`-separated hashes get mangled by compose interpolation. Rules out:
env_file in deploy compose, `$` separators in any env-carried value.

**2026-07-11 — Deploy compose ships an OPTIONAL bundled MinIO behind a
compose profile; default is external S3.** `docker compose up -d` = server
only, pointed at existing storage (the owner's case);
`--profile bundled-minio` = fully self-contained stack for first-runs/other
hosts. Why: deployment convenience without touching the app's
storage-agnostic design (hard rule 5); the owner already runs MinIO. Rules
out: baking MinIO into the server image or making it a hard compose
dependency.

**2026-07-11 — Monorepo tooling: npm workspaces with TS-source internal
packages.** `shared/` exports raw `.ts` (no dist/); esbuild/tsx/vitest consume
it directly, `tsc --noEmit` per package for types. Node 24 (engines ≥22).
Fastify 5 + @fastify/websocket, @aws-sdk/client-s3 (forcePathStyle), vitest,
eslint 9+ flat config with a mechanical ban on Node/Electron imports in
plugin/ and shared/ (enforces hard rule 2), prettier. Why: kills stale-build
bugs between workspaces; boring, long-maintenance choices. Rules out: build
steps for shared/, publishing workspace packages.

**2026-07-12 — Device names exposed to authenticated clients (`GET /devices`,
`PATCH /devices/self`).** Enables the plugin's version-history UI to label
revisions by originating device instead of only "this device". No E2EE
change: device names are user-supplied plaintext the server has always held
(set at login, shown in `admin device-list`); listing them to the single
user's own authenticated devices adds no exposure. `token_hash` never appears
in any response. PATCH renames only the calling device (id from the auth
token), closing the gap where a device name edited in plugin settings after
login never reached the server.

**2026-07-12 — Plugin caches decrypted vault names in data.json
(`vaultName` + `knownVaultNames`).** Settings UI shows names instead of
UUIDs; raw ids move behind copy-to-clipboard buttons for CLI
cross-referencing. Same rationale as the persisted VMK: the device already
holds the entire vault in plaintext, so a locally cached name adds no
exposure, and names still never reach the server unencrypted. Pre-unlock,
the vault dropdown can only name vaults previously unlocked on that device —
other vaults' names stay ciphertext until their passphrase is entered.

**2026-07-12 — Version-history preview and diff are fully client-side,
size/type-gated.** The history modal gains a detail view: decrypted preview
plus a unified two-way line diff ("vs current" and "vs previous"), rendered
with node-diff3's `diffComm` — the same LCS already trusted for merge, no new
dependency. The selected revision is always the "new" diff side (additions =
what restoring brings in). Gates: text preview only for mergeable-text
extensions ≤1 MiB (the merge-base-cache ceiling, mobile OOM guard) and diffs
≤10k lines per side (LCS is O(n·m)); everything else gets a metadata panel.
Restore now demands an inline confirm. Nothing changes server-side or in the
protocol — the server still sees only ciphertext.

**2026-07-12 — `admin set-password` persists the hash to
`DATA_DIR/account.json`; file OVERRIDES env.** Supersedes the 2026-07-11
"stays env-only" decision via its own revisit trigger (provisioning friction).
Why file-over-env: in Docker the env is baked into the stack, so env-wins
would make set-password silently inert; the env value remains the
bootstrap/recovery credential (losing DATA_DIR falls back to it — possibly an
older password). Why a DATA_DIR file and not SQLite or the bucket: the index
must stay rebuildable-from-bucket with zero loss, and the bucket must stay a
credential-free backup (same reasoning as local-only session tokens). The
hash is re-resolved per login, so changes apply without restart; existing
device tokens survive a password change (independent credentials —
`device-revoke` evicts). Startup logs the active source. Rules out:
interactive-only set-password (Docker-unfriendly); `--stdin` keeps passwords
out of shell history.

**2026-07-12 — Multi-user remains out of scope; outlook recorded.** A robust
multi-user setup would need: per-user password hashes persisted as bucket
sidecars (account data, unlike sessions, must survive index loss), vault
ownership/membership with per-user route filtering, devices bound to users,
and — the hard part — E2EE vault sharing (shared passphrase out-of-band, or
per-user keypairs with the VMK wrapped per member). `account.json
{ passwordHashV1 }` is deliberately trivial to supersede wholesale. Nothing
in the current design blocks that path; nothing anticipates it prematurely.

**2026-07-12 — `docs/` adopts the Diátaxis structure.** User-facing
documentation splits into `tutorials/` (getting-started, absorbed from
deployment.md), `how-to/` (password change, device management, vault
deletion, backup/restore, updates), `reference/` (admin CLI with worked
examples, server configuration), and `explanation/` (architecture,
sync-protocol — moved, content unchanged). `deployment.md` is dissolved into
those; `docs/README.md` is the map. The two internal work-artifacts —
`mvp-spec.md` and this decision log — deliberately stay at the docs root:
they are engineering documents, not user documentation, and CLAUDE.md's
read-first list keeps stable paths.

**2026-07-12 — `.obsidian` settings sync ships; config conflicts resolve by
last-writer-wins-with-history, NOT diff3 or conflict siblings.** This
deliberately amends hard rule 4's letter ("conflicts fall back to conflict
files") for config paths only, preserving its intent (no unrecoverable
loss): diff3 line-merging JSON can emit invalid or semantically broken
config, and a conflict sibling inside `.obsidian` is a file Obsidian never
reads — the sibling itself would be the silent discard. Under LWW both
versions become revisions (local-vs-remote conflicts push the local side as
a sibling head first, then a merge revision citing both parents carries the
winner; concurrent heads pick winners by newest clientMtime, ties by
greatest revision id, so every device converges identically), the loss is
surfaced in the activity log, and recovery is one click in the version
history UI ("Version history for a synced settings file" command —
config files have no TFile, so the file-menu entry points can't reach
them). Known bias: device clock skew tilts LWW; losses are always
recoverable from history. Verified by a convergence test against the real
server.

**2026-07-12 — Config wire paths use a canonical `.obsidian/` prefix
regardless of the local `configDir` name.** Obsidian's config folder is
renameable; `ConfigFs` maps canonical ↔ local (NFC + forward slashes applied
before both pathHmac and encryptPath — encryptPath seals verbatim, so both
must see the identical canonical string). Devices with mismatched configDir
names still converge on the same items.

**2026-07-12 — Settings sync is per-device opt-in, default OFF on all
platforms; disabling stops updates and never deletes.** Owner chose safety
over convenience: no surprise config overwrites on plugin update day.
Category toggles (appearance / hotkeys / core / community plugin settings /
community plugin code) default on once the master toggle is enabled;
unknown future config files land in the core bucket so they sync under a
toggle. Exclusion rides the existing stop-updating machinery (planner's
excludedByPolicy runs before the delete branch — pinned by a planner test).
Plugin code sync is included (spec's "optionally plugin code") with the
warning that synced code executes; mobile guidance is to leave it off.

**2026-07-12 — Settings-sync hard exclusions: own plugin dir, workspace*,
tmp/bak junk — enforced at walk time AND in the exclusion callback.**
`plugins/vault-sync/` holds data.json with the bearer token and the
UNWRAPPED VMK plus the sync index and spool: syncing it would upload the
VMK encrypted under keys derived from itself (pointless risk, fatal for any
future key rotation) and create index/spool feedback loops. `workspace*`
(top level) is per-device window state that churns constantly. The dual
enforcement means a malicious or buggy remote head for an excluded path can
never be pulled.

**2026-07-12 — Selective-sync categories align exactly with Obsidian's
official format lists; never-excludable = the native trio {md, canvas,
base}; merge policy decoupled from excludability.** Source of truth:
obsidian.md/help/file-formats. Image/audio/video/pdf toggle sets are
Obsidian's accepted extensions verbatim; webm (dual-listed by Obsidian under
audio and video) classifies as video. Former extras (heic, heif, oga, aac,
opus, avi, m4v) and former always-sync text formats (txt, json, csv, yml,
yaml, org, tex) move under the "All other types" toggle — a BEHAVIOR CHANGE
for released users who disabled "other": those text files stop updating
(stop-updating semantics, nothing deleted; re-enabling rejoins normally,
though a divergent re-inclusion can conflict-sibling because the cached
merge base is dropped on exclusion). Those text formats remain
diff3-mergeable while synced: isMergeableText (merge policy) and categoryOf
(sync policy) are now independent axes. `.base` (Obsidian Bases, YAML) is
added to both: never-excludable and mergeable — devices on older builds
treat .base as "other" and won't text-merge it until updated (transient;
release-note).

**2026-07-12 — Settings-sync toggles adopt Obsidian Sync's
vault-configuration granularity (9 toggles).** Main settings / Appearance /
Themes and snippets / Hotkeys / Active core plugin list / Core plugin
settings (default bucket for unknown config) / Active community plugin list
/ Community plugin settings / Installed community plugins — per
obsidian.md/help/sync/settings, with plugin settings split from plugin code
so mobile can take settings without executing synced code. The previous
5-key shape never shipped (uncommitted), so no data.json migration; the
loadSettings deep-default guards nested toggle objects against missing keys
(undefined would read as "excluded"). Hard 'never' rules and LWW unchanged.

**2026-07-12 — Folder connections: mount additional server vaults at local
folders, each a dedicated vault.** Enables syncing a single folder (e.g.
reference material) between otherwise-unrelated vaults (personal, work)
without either side holding the other's master key. Each folder connection
is its own server vault — own VMK envelope, passphrase, revision history —
so a compromised or lost device only ever exposes the vaults it was
explicitly given, never a whole other vault's worth of content via one
shared key. Zero server/protocol changes: vault namespaces were already
independent and the bearer token was already account-wide (one token syncs
N vaults). Wire paths for a mounted connection are relative to the mount
root (e.g. `notes/x.md`), not the local folder name — the same shared vault
mounts identically at any local path in any vault, mirroring the
`.obsidian/` canonical-prefix precedent. First connect join-merges existing
local content with the shared vault, identical to a second device joining
(dedupe/merge/conflict — nothing lost). The plugin's main whole-vault
connection excludes every mounted prefix by policy (stop-updating, same
machinery as a category toggle) — pre-existing main-vault content at that
path freezes rather than fighting the mount; disconnecting reverses this
automatically. Settings sync (`.obsidian`) stays main-vault-only; a shared
vault's own `.obsidian/*` items (if any) are policy-excluded inside the
mount so a mistakenly-mounted vault can never write into the real config
dir. Multiple connections sync strictly sequentially — this preserves the
per-engine memory guarantees (single large-transfer lock, bounded
parallelism) without needing a cross-engine budget/lock, at the cost of one
extra heads round-trip per connection per sync pass (fine for small shared
vaults).

**2026-07-12 — Engine refactored onto a `SyncScope` filesystem seam; the
engine now operates in a single path domain per connection.** Previously the
engine mixed "local path" and "server-decrypted path" because they were
always identical; folder connections make them differ (`Reference/x.md`
local ↔ `x.md` on the wire). Rather than remap at ~10 scattered call sites
(the exact bug class this must avoid), `EngineOptions` no longer holds a
`Vault` or `ConfigFs` at all — only a `SyncScope` — so the compiler enforces
that all local I/O goes through one seam per connection. `VaultScope`
implements both the whole-vault mode (current behavior, mount-prefix
exclusion) and mount mode (prefix-stripped scan/read/write, `.obsidian/*`
policy-excluded). A mounted folder's missing/renamed root is guarded
explicitly (`isRootPresent`) — the planner must never see "everything
gone" and emit mass deletes; the pass is skipped with one notice instead
(hard rule 4). Spool roots move to `spool/<vaultId>` (previously a single
shared directory, which would have made two connections garbage-collect
each other's in-flight downloads); a startup sweep clears legacy spool
children. One-time change-source registrations (vault events, periodic
rescan, visibility, polling) moved from the per-connection rebuild path
into `onload`, fixing a latent bug where they'd have stacked duplicate
handlers on every reconnect.

**2026-07-12 — Vaults carry a server-visible `kind` (`'vault' | 'folder'`);
identical content adopts instead of conflicting.** Two fixes to the folder-
connection feature. (1) A folder-share is an ordinary server vault, so the
settings dropdowns offered *every* account vault as a folder-connection
candidate (and folder shares as whole-vault candidates). A device that has not
unlocked a vault can't read its encrypted name, so the distinction can't be
client-only — it must be legible pre-unlock. We add a `kind` enum to the vault
record (schema, `vault` table with an idempotent `ALTER TABLE` migration to v3,
bucket sidecar, `GET/POST /vaults`), defaulting to `'vault'`; the "Create a new
shared vault" flow marks `'folder'`. This does **not** weaken E2EE (hard rule
1): `kind` is structural classification, not file content, names, or paths, and
not key material — the same category as `createdAt`/`kdf` the server already
holds, consistent with the device-name precedent. Sidecars written before v3
have no `kind` and rebuild as `'vault'`, so `rebuild-index` stays lossless. The
"Connect to existing vault" dropdown now shows only `'vault'`, "Add folder
connection" only `'folder'`. (2) Disconnecting a folder connection drops its
local sync index; on reconnect `merge()` saw `base == null`, skipped the three-
way merge, and wrote a `(conflict ...)` sibling even for a byte-identical file
that never diverged. `merge()`/`mergeHeads()` now short-circuit on identical
content (byte equality, plus newline- and NFC-normalized equality for mergeable
text): adopt the remote revision and re-seed `basePlaintext` so the next real
edit has a merge base again. This makes good on the "identical files: no-op"
promise the docs already stated. Nothing changes on the wire for the merge fix.

**2026-07-12 — Settings vault list auto-refreshes once per pane open.** The
"Add folder connection" / "Connect to existing vault" dropdowns are populated
by `loadVaults()`, previously called only at login and via a manual "Refresh
vault list" button — so a share created moments earlier (on this vault, another
vault, or another device) was invisible until a manual refresh, which read as
"the vault can't see its own share". The connection tab now fires one
`loadVaults()` per pane open (guarded against the render→load→render loop,
reset in `hide()`), and create/connect/disconnect re-fetch the list. The manual
button stays as a force-refresh with a clarifying tooltip.
