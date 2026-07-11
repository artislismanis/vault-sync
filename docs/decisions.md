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
