# Roadmap

Prioritised backlog sourced from a 2026-07-12 survey of eight comparable
Obsidian-sync projects (Osync-p, vaultguard-obsidian, obsidian-ugreen-sync,
obsidian-conflict-manager, ObsidianGoogleDriveSync, obsyncian, pkv-sync-plugin,
nas-sync-plugin) plus the owner's own obsidian-agent-sandbox.

This file is **execution order and provenance**, not scope. Scope lives in
[mvp-spec.md](mvp-spec.md) — its Phase 2/Phase 3 lists are the source of truth
for _what_ is planned; this file says _which order_ and _why_, and traces each
item back to where the idea came from. Don't let the two diverge: if an item
here changes Phase 2/3 scope, update `mvp-spec.md` too. Adopting a Tier 2 item
requires a decision entry in [decisions.md](decisions.md) first.

A ninth project, kavinsood/yaos (a CRDT-based Obsidian sync engine on
Cloudflare Workers, no E2EE), was reviewed on 2026-08-24. Most of its
complexity is downstream of a monolithic CRDT doc, a live editor binding, and
Cloudflare row budgets — none of which apply here — but the review also
surfaced two real defects in our own engine, fixed the same day
(`docs/decisions.md`). Items below sourced from it are marked "Source: yaos".
Rejected ideas from that review are recorded at the bottom of this file so
they aren't re-proposed from a future re-read.

## Settled — verified already implemented

Before ranking, five "we might already do this" candidates were checked
against the code. All five are already correct — they are not backlog items,
just documented here so nobody re-investigates them:

| Pattern                                                                                                                                                                                                                | Where                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `node-diff3` `excludeFalseConflicts: true` (identical concurrent edits don't spuriously conflict)                                                                                                                      | `plugin/src/merge/diff3.ts:11`                                                            |
| Change detection compares size **and** mtime — beats mtime-alone only, not a correctness primitive; still misses tools that preserve mtime (corrected 2026-08-24, `docs/decisions.md`)                                 | `plugin/src/sync/planner.ts:105`, `plugin/src/sync/engine.ts:765`                         |
| Self-write suppression — real, but coarser than it reads: only guards event-driven scheduling, not a concurrent edit landing mid-await inside `pull`/`merge`/`deleteLocal` (D1, fixed 2026-08-24, `docs/decisions.md`) | `plugin/src/sync/engine.ts:101`                                                           |
| Renderer yielding during large batch transfers (no Obsidian UI freeze)                                                                                                                                                 | `plugin/src/sync/engine.ts:64` (`yieldMain`), called at upload/download/spool loop points |
| Poison isolation (one bad blob doesn't stall a batch; failures retry next sync)                                                                                                                                        | `plugin/src/sync/engine.ts:186-216`                                                       |

## Tier 1 — near-term, high-value, low-risk

No architecture decision needed; build directly.

- **Settings-tab styling** — underline tabs (flat button, accent underline on
  active) replacing the heavier `mod-cta` filled-button treatment, applied to
  both the settings pane and the version-history modal. _Implemented
  2026-07-12_ — see `decisions.md`. Source: obsidian-agent-sandbox
  `renderTabs`/`sandbox-settings-tab` CSS.
- **Conflict-review UX** — _implemented 2026-08-24_: discovery (a `Notice` on
  opening a conflicted note, a status-bar warning state + right-click "Review
  conflicts (N)") plus a review modal (`ConflictModal`) reusing `linediff.ts`
  and the existing `.vault-sync-diff-*` CSS verbatim — both sides of a
  conflict are already plain local files, so no decrypt/network is needed to
  diff them. Detection is a new pure module (`sync/conflict-detect.ts`)
  pattern-matching the `(conflict …)` filename shape; "resolved" is simply
  "the sibling no longer exists" (a "Delete conflict copy" button, recoverable
  via `.trash`) — no new persisted state. Two scope calls made explicit in
  `docs/decisions.md`: a `Notice` + status bar instead of a true in-editor
  banner (this codebase has no editor-injection precedent at all — no
  CodeMirror, no `registerMarkdownPostProcessor` — and building one is
  disproportionate risk for what a Notice already covers); and line-level
  diff only — **char-level highlighting is still open**, deferred as an
  isolated fast-follow since it needs a real shape change to `DiffLine` (no
  pairing between a del-line and its add-line today). Source:
  obsidian-conflict-manager (`notifier.ts`, `indicator.ts`, `unified-diff.ts`).
- **Mass-delete safety guard + preview-before-confirm modal** — _fully
  implemented 2026-08-24_: `applySafetyBrake()` in `planner.ts`, threshold
  AND(count > 20, ratio > 25%) evaluated independently for server-destructive
  (`pushDelete` vs. known index size) and local-destructive
  (`pull`-over-existing-file + `deleteLocal` vs. current local file count)
  actions. Blocked actions are surfaced via `SyncEngine.blockedActions` and a
  `SafetyBrakeModal` (status-bar `shield-alert` state, "Review blocked
  changes (N)" menu item and command) with a two-step "Force sync" per
  connection that bypasses the guard for one run. Also added a
  `DeleteBurstTracker` (`sync/delete-burst.ts`) — a trailing-window (10 min /
  50 deletes) **rate** gate independent of the batch guard's per-pass
  **ratio**, catching a trickle of deletes spread across many small passes
  that each individually stay under threshold. Details and two design
  corrections made before shipping (why the burst gate only counts
  _executed_ deletes, and why its cap sits above the batch guard's own
  threshold rather than shadowing it): `docs/decisions.md`. Seen
  independently in three projects now (Osync-p, ObsidianGoogleDriveSync,
  yaos — the third sighting is what tipped this from "someday" to "build
  now", alongside a verified defect it closes, D2).
- **Blocked-file tracking by (size, mtime)** to stop retry-storming permanent
  errors (quota exceeded, oversized) every reconciliation cycle instead of
  silently retrying forever. Source: obsyncian.
- **WS retry-queue separation**: confirm reconnect backoff (socket down) and
  failed-operation retry (operation down) use independent backoff ranges
  rather than one shared timer, plus a post-pull "ignore window" so pulls
  don't get misread as new external edits. Source: nas-sync-plugin. Likely a
  small fix if not already separated — verify against `plugin/src/sync/engine.ts`
  before building.
- **Content-state guard on `pull`/`merge`/`deleteLocal`** — _implemented
  2026-08-24_: a local edit landing while `readBlob()` awaited a chunked
  download could be silently overwritten and recorded as synced (D1, a real
  hard-rule-4 violation, not a hypothetical). Fixed by re-hashing current disk
  content immediately before each write; on mismatch the action is dropped
  without advancing the index (`docs/decisions.md`). Source: yaos
  (`docs/architecture/filesystem-bridge.md`'s "bind suppression to observed
  content, not elapsed time").
- **Canonical-path collision detection** — _implemented 2026-08-24_:
  `VaultScope.scan()` passed raw (non-normalized) paths, so an NFC- and an
  NFD-spelled file could coexist locally while colliding on one server
  `pathHmac` (D3 — the server cannot detect this itself under E2EE).
  `canonical-path.ts` detects the collision and both paths are excluded from
  that sync pass with a notice, rather than corrupting each other via
  `mergeHeads`. Source: yaos (`src/paths/canonicalPath.ts`,
  `findCanonicalPathCollisions`).
- **Runtime version/capability negotiation**: `/healthz` returns a version,
  but nothing lets an updated plugin detect and gracefully degrade against an
  older server — users update BRAT and Docker independently, so version skew
  is a real, reachable state, not hypothetical. Needs a wire protocol version
  constant first (`shared/src/protocol/` has none today). Source: yaos
  (`GET /api/capabilities` — their plugin disables attachment/snapshot UI
  when the server lacks an R2 binding; degrade a feature, don't fail a sync).
- **Surface the durability receipt as a "safe to close" state**: `POST
/revisions` returning `201` already means the revision is durably in object
  storage (write-ahead: sidecar → index → ack) — we already have what yaos
  spent 1,153 lines building (`docs/engineering/server-ack-design.md`) to
  approximate for a CRDT's ackless WebSocket. What's missing is surfacing it
  in the plugin UI, which matters most on mobile where iOS can kill the app
  mid-sync. UI/status semantics only, no protocol work.
- **Two doc genres**, both fitting the existing Diátaxis + `decisions.md`
  culture at near-zero cost: a `warts-and-limits.md` page of accepted
  compromises and their reasons (distinct from `decisions.md`, which records
  choices, not known sharp edges); and a `sync-vocabulary.md` naming
  canonical subsystems/states/reason codes, with the rule that user-facing
  copy maps back to exactly one of each. Cheap now, harder to retrofit once
  ad hoc naming has spread through the code. Source: yaos
  (`docs/architecture/warts-and-limits.md`, `docs/engineering/sync-vocabulary.md`).

## Tier 2 — needs a decision first (write an ADR, then build)

Both items below are genuinely good ideas with a real cost that must be
decided explicitly, not defaulted into.

- **Presigned direct-to-storage URLs for blob transfer** (client PUTs/GETs
  ciphertext directly to the object store, bypassing our server for bytes).
  Seen in both Osync-p (MinIO) and obsyncian (R2), with batched presigns and
  bounded concurrency in the latter — two independent implementations
  converging on the same design. **The cost**: it makes the object store a
  _second_ internet-exposed surface. Osync-p's own docs require two sibling
  subdomains and an exact `MINIO_PUBLIC_URL` match, which cuts against our
  current single-endpoint / one-reverse-proxy-or-VPN model
  (`docs/explanation/architecture.md`, `docs/tutorials/getting-started.md`
  §4). Real server-bandwidth/CPU win; real deployment-complexity cost.
  Decide which side of that trade we want before implementing.
- **At-rest encryption of the local merge-base plaintext cache**
  (`docs/explanation/sync-protocol.md`'s base-plaintext cache, currently
  unencrypted on disk under the size cap). Source: vaultguard-obsidian
  (`safe-storage.ts`, `at-rest-cipher.ts`), which wraps its local cache with a
  per-device key from the OS keychain so Spotlight/Finder/Windows
  Search/backup tools never see plaintext. **The catch**: their mechanism
  (Electron `safeStorage`) is desktop-only — there's no OS-keychain equivalent
  reachable from Obsidian mobile, which collides with hard rule #2 (the
  plugin must run on mobile). Any adoption must be scoped desktop-first with
  an explicit, stated answer for what mobile does instead (most likely:
  nothing extra, since the VMK itself is already passphrase-protected) rather
  than presented as uniform. Still closes a real gap — the local cache is
  currently plaintext at rest right next to a server that's supposed to never
  see plaintext at all.

## Tier 3 — beyond MVP

Cross-references `mvp-spec.md`'s "Phase 3+ — ideas parking lot"; items below
add provenance and priority signal to that list rather than replacing it.

- **MCP server for scoped AI-agent note access.** Two independent sightings
  (vaultguard-obsidian's Claude chat panel + MCP server, pkv-sync-plugin's
  built-in MCP server), and the owner already runs Claude Code against this
  vault day-to-day (hard rule #3 already treats those edits as first-class).
  Worth treating as a potentially distinctive feature rather than a novelty
  once core sync is solid — separate scoping conversation, not a checklist
  item.
- **Multi-user permission model** (vault/folder/file-level grants, role
  inheritance, server-side default-deny). Maps directly to the existing Phase
  3+ "multi-user / shared vaults" item. Source: vaultguard-obsidian's
  `permissions/handler.ts` + `permission-store.ts` split is reasonable prior
  art for the client/server boundary.
- **Offboarding re-encryption on revoke; time-bound key leases.** Same trigger
  as our already-documented "full VMK rotation on compromise"
  (`docs/explanation/sync-protocol.md`), just automated. Only matters once
  there's a second reader to revoke, i.e. after multi-user lands.
- **Device pairing-code / QR onboarding**, and one-paste server config (a
  single URL populating server/org/credentials instead of several manual
  fields). Realises the existing Phase 2 "QR-code / one-tap device pairing"
  item. Sources: nas-sync-plugin (pairing code), vaultguard-obsidian
  (`.well-known/vaultguard.json` config URL).
- **PIN/biometric app-lock** (vaultguard-obsidian) — gates viewing decrypted
  notes even on an already-unlocked device. Phase 2/3 UX hardening, not core
  sync.
- **Admin web UI + metrics** (pkv-sync-plugin, nas-sync-plugin: conflict
  list/resolve, trash recovery, device list, Prometheus metrics). We're
  CLI-only by design for single-user MVP (`mvp-spec.md`); revisit only if that
  stops being sufficient.
- **Redacted diagnostics export.** Under E2EE our paths are secret, so a debug
  bundle containing filenames is a confidentiality bug, not a hygiene issue —
  and today the activity log is in-memory only (200 entries, session
  lifetime), so there is nothing to send when something goes wrong on a
  phone. Source: yaos (`src/telemetry/diagnostics/pathRedactor.ts`): a
  per-bundle salted hash, stable within one bundle so events still correlate,
  fresh across bundles so collecting several can't enumerate paths by
  intersection; salt never ships. Pair with a filenames-included variant
  behind explicit confirmation, as they do.

## Non-technical threads

- **Licensing stance**, decided deliberately before any public release. The
  surveyed field spans fully open (MIT), source-available-with-commercial-
  restriction (vaultguard-obsidian's Sustainable Use License, open-core with
  paid cloud tiers), and open-plugin/closed-server (obsyncian). Not urgent now.
- **Security-event notifications** — a lightweight webhook (or the DSM
  webhook path documented in
  [deploy-on-synology.md](how-to/deploy-on-synology.md)) firing on "new device
  authorized" or "failed login", closing a real blind spot: nothing currently
  tells the owner if the vault is accessed somewhere unexpected. Source:
  Osync-p's optional Telegram notifications for account events.
- **"Known limitations" transparency** — already good practice here
  (`mvp-spec.md`'s explicit non-goals section, stated up front rather than
  buried); worth deliberately preserving as the project grows, not a gap.

## Reviewed and rejected (yaos, 2026-08-24)

Recorded so a future re-read of yaos doesn't re-propose these:

- **`externalEditPolicy` (`never` / `closed-only` import of external edits)**
  — exists in yaos because their live editor binding makes external edits to
  an open file genuinely dangerous. A "never import external edits" toggle
  would **contradict hard rule #3** (external edits are first-class). Not
  portable.
- **The frontmatter-integrity RFC** (529 lines) — their duplicate-YAML-key
  corruption is a byte-level-CRDT pathology we structurally cannot have. Not
  zero-risk for us (diff3 can produce duplicate keys when both sides insert
  the same key at different offsets, since non-overlapping edits auto-merge),
  but that's a small targeted test case, not a 529-line RFC.
- **Block-level / delta chunking analysis** — we already ship chunked +
  resumable transfers, and their refusal reasoning is Cloudflare-row-budget
  arithmetic that doesn't transfer to an S3-compatible backend. Our own
  delta-sync question (`mvp-spec.md` Phase 2) stands on its own merits,
  unrelated to yaos' reasoning.
- **Checkpoint+journal persistence, tombstone reaper, monolithic-doc memory
  model** — artefacts of the CRDT architecture; nothing to port.
- **CRDT/Yjs sync itself** — buys real-time co-editing, which we don't
  target, at the cost of an architecture where E2EE isn't achievable as
  they've built it (the server holds plaintext CRDT state). Hard rule #1
  settles this the same way the Validation note below settles it against the
  other eight surveyed projects.

## Validation note

Six of the eight surveyed projects ship either no E2EE at all or a materially
weaker crypto construction (random-nonce AES-GCM with no AAD, PBKDF2 instead
of Argon2id). That's read as evidence the E2EE-non-negotiable stance (hard
rule #1) is the actual differentiator in this space, not over-engineering —
worth holding the line on rather than trading it away for any Tier 2/3 item
above. yaos (no E2EE at all, reviewed 2026-08-24) is the ninth data point in
the same direction.
