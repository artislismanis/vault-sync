# vault-sync

Self-hosted, end-to-end-encrypted sync for Obsidian vaults: a TypeScript sync
server + an Obsidian plugin (desktop and mobile), replacing Obsidian Sync at
rough feature parity. Single user, multiple vaults. Working name — rename freely.

## Read these before designing or building anything

- `docs/mvp-spec.md` — scope, phases, parity checklist. The source of truth for WHAT to build.
- `docs/sync-protocol.md` — E2EE model, versioning, merge strategy. Read before touching sync logic.
- `docs/architecture.md` — components, storage layout, deployment model.
- `docs/decisions.md` — decision log (ADR-style). APPEND to this whenever a significant choice is made or changed. Never silently contradict it.

## Repo layout

```
server/    Node/TypeScript sync server (Docker-deployed)
plugin/    Obsidian plugin (TypeScript, bundled with esbuild)
shared/    Protocol types, schemas, crypto helpers shared by both
docs/      Specs and decisions (see above)
```

## Commands

- Install: `npm install` (npm workspaces: server, plugin, shared)
- Build all: `npm run build` (type-checks all packages, then bundles server + plugin)
- Test all: `npm test` (vitest, all workspaces)
- Lint: `npm run lint` — includes a mechanical ban on Node/Electron imports in `plugin/` and `shared/`
- Format: `npm run format`
- Server dev: `npm run dev -w server` — reads S3 endpoint/credentials from `../.env`
  (copy `.env.example`; point at any S3-compatible store). `docker-compose.dev.yml`
  is an OPTIONAL throwaway MinIO for integration testing only.
- Admin CLI: `npm run -w server admin -- <hash-password|vault-list|rebuild-index>`
- Plugin dev build: `npm run dev -w plugin` (watch mode; set `OUTFILE=<vault>/.obsidian/plugins/vault-sync/main.js` to build into a test vault)
- Plugin release build: `npm run build -w plugin` → `plugin/main.js`
- Release (plugin + server image): `npm version patch -w plugin` (syncs
  manifest.json/versions.json) → commit → `git tag <version>` (bare semver,
  no `v`, must equal manifest version) → `git push && git push --tags`.
  GitHub Actions then publishes the BRAT release assets and pushes
  `ghcr.io/artislismanis/vault-sync-server:<version>` + `:latest`.

## Hard rules

1. **E2EE is non-negotiable.** The server must never see plaintext file content,
   file names, or paths, and must never receive key material. If a feature seems
   to require server-side plaintext, stop and flag it — do not weaken the model.
2. **The plugin must run on mobile.** No Node APIs (`fs`, `path`, `crypto` from
   Node) in plugin code. Use Obsidian's `Vault`/`Adapter` APIs for all file I/O
   and Web Crypto / libsodium-wasm for crypto. Assume iOS/Android kill background
   connections: sync must fully recover from cold start on foreground.
3. **External edits are normal, not exceptional.** Files change outside Obsidian
   (Claude Code, scripts, files dropped in via the OS). Never assume vault events
   are the only change source; reconciliation scans are a core mechanism.
4. **Never lose user data.** Every destructive path (overwrite, delete, merge)
   must first record the prior version to history. Conflicts fall back to
   conflict files, never to silent discard.
5. **Server stays generic.** No Synology-specific code. Anything host-specific
   goes in deployment docs/compose files only. Storage access goes through the
   S3-compatible interface exclusively.
6. **Protocol types live in `shared/` only.** Server and plugin must import the
   same schema definitions; never duplicate message shapes.

## Workflow preferences

- For any new subsystem (sync engine, merge, crypto, protocol changes): plan
  first against the docs, surface open questions, then implement.
- Prefer boring, well-maintained libraries; this must run unattended for years.
- Write tests alongside sync/merge/crypto logic — these are the correctness core.
- Update `docs/` in the same change when behaviour diverges from the spec.
