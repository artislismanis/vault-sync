# Roadmap

Prioritised backlog sourced from a 2026-07-12 survey of eight comparable
Obsidian-sync projects (Osync-p, vaultguard-obsidian, obsidian-ugreen-sync,
obsidian-conflict-manager, ObsidianGoogleDriveSync, obsyncian, pkv-sync-plugin,
nas-sync-plugin) plus the owner's own obsidian-agent-sandbox.

This file is **execution order and provenance**, not scope. Scope lives in
[mvp-spec.md](mvp-spec.md) — its Phase 2/Phase 3 lists are the source of truth
for *what* is planned; this file says *which order* and *why*, and traces each
item back to where the idea came from. Don't let the two diverge: if an item
here changes Phase 2/3 scope, update `mvp-spec.md` too. Adopting a Tier 2 item
requires a decision entry in [decisions.md](decisions.md) first.

## Settled — verified already implemented

Before ranking, five "we might already do this" candidates were checked
against the code. All five are already correct — they are not backlog items,
just documented here so nobody re-investigates them:

| Pattern | Where |
|---|---|
| `node-diff3` `excludeFalseConflicts: true` (identical concurrent edits don't spuriously conflict) | `plugin/src/merge/diff3.ts:11` |
| Change detection compares size **and** mtime, not mtime alone | `plugin/src/sync/planner.ts:105`, `plugin/src/sync/engine.ts:765` |
| Self-write suppression (engine writes don't re-trigger as external edits) | `plugin/src/sync/engine.ts:92` |
| Renderer yielding during large batch transfers (no Obsidian UI freeze) | `plugin/src/sync/engine.ts:64` (`yieldMain`), called at upload/download/spool loop points |
| Poison isolation (one bad blob doesn't stall a batch; failures retry next sync) | `plugin/src/sync/engine.ts:186-216` |

## Tier 1 — near-term, high-value, low-risk

No architecture decision needed; build directly.

- **Settings-tab styling** — underline tabs (flat button, accent underline on
  active) replacing the heavier `mod-cta` filled-button treatment, applied to
  both the settings pane and the version-history modal. *Implemented
  2026-07-12* — see `decisions.md`. Source: obsidian-agent-sandbox
  `renderTabs`/`sandbox-settings-tab` CSS.
- **Conflict-review UX**: a banner on note-open when a `(conflict …)` sibling
  exists for that note, a status-bar state change (ok/warning), and a
  unified-diff review pane (line diff + char-level highlighting, collapsed
  unchanged context). We already generate conflict siblings correctly
  (`docs/explanation/sync-protocol.md`) and already have diff-highlight CSS
  (`plugin/styles.css` `.vault-sync-diff-*`); the actual gap is *discovery* —
  today a conflict is a silently-created file the user has to notice in the
  file tree. Source: obsidian-conflict-manager (`notifier.ts`, `indicator.ts`,
  `unified-diff.ts`).
- **Mass-delete safety guard + preview-before-confirm modal**: block or
  require explicit confirmation when a sync would delete ≥50 items or ≥30% of
  known entries (min 5), with a modal listing what's about to change before
  the user confirms — not a bare "are you sure?". Seen independently in two
  unrelated projects (Osync-p, ObsidianGoogleDriveSync), which is a stronger
  signal than a single sighting, and it serves hard rule #4 (never lose data)
  directly. Companion: a delete-burst detector (rate-based: N deletes within a
  trailing window) to catch bursts *between* reconciliation passes, which the
  batch-level guard alone would miss.
- **Blocked-file tracking by (size, mtime)** to stop retry-storming permanent
  errors (quota exceeded, oversized) every reconciliation cycle instead of
  silently retrying forever. Source: obsyncian.
- **WS retry-queue separation**: confirm reconnect backoff (socket down) and
  failed-operation retry (operation down) use independent backoff ranges
  rather than one shared timer, plus a post-pull "ignore window" so pulls
  don't get misread as new external edits. Source: nas-sync-plugin. Likely a
  small fix if not already separated — verify against `plugin/src/sync/engine.ts`
  before building.

## Tier 2 — needs a decision first (write an ADR, then build)

Both items below are genuinely good ideas with a real cost that must be
decided explicitly, not defaulted into.

- **Presigned direct-to-storage URLs for blob transfer** (client PUTs/GETs
  ciphertext directly to the object store, bypassing our server for bytes).
  Seen in both Osync-p (MinIO) and obsyncian (R2), with batched presigns and
  bounded concurrency in the latter — two independent implementations
  converging on the same design. **The cost**: it makes the object store a
  *second* internet-exposed surface. Osync-p's own docs require two sibling
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

## Validation note

Six of the eight surveyed projects ship either no E2EE at all or a materially
weaker crypto construction (random-nonce AES-GCM with no AAD, PBKDF2 instead
of Argon2id). That's read as evidence the E2EE-non-negotiable stance (hard
rule #1) is the actual differentiator in this space, not over-engineering —
worth holding the line on rather than trading it away for any Tier 2/3 item
above.
