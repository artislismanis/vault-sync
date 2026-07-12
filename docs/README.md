# Documentation map

Organized along [Diátaxis](https://diataxis.fr) lines: learning, doing,
looking up, understanding.

## Tutorials — start here

- [Getting started](tutorials/getting-started.md) — deploy the server
  (Synology walkthrough), HTTPS, install the plugin via BRAT, first sync,
  convergence test.

## How-to guides — day-2 operations

- [Sync Obsidian settings](how-to/sync-obsidian-settings.md) — `.obsidian`
  config across devices
- [Share a folder between vaults](how-to/share-a-folder-between-vaults.md) —
  mount a shared vault at a local folder
- [Change the account password](how-to/change-the-account-password.md)
- [Manage devices](how-to/manage-devices.md) — list, rename, revoke
- [Delete a vault](how-to/delete-a-vault.md)
- [Back up and restore](how-to/back-up-and-restore.md)
- [Update server and plugin](how-to/update-server-and-plugin.md)
- [Deploy on Synology](how-to/deploy-on-synology.md) — Container Manager
  conventions, reverse proxy details, storage options

## Reference — look things up

- [Admin CLI](reference/admin-cli.md) — every command, with examples
- [Server configuration](reference/server-config.md) — env vars, data
  locations, password sources

## Explanation — how and why it works

- [Architecture](explanation/architecture.md) — components, stack, deployment
  model
- [Sync protocol](explanation/sync-protocol.md) — E2EE model, revision DAG,
  merge strategy

## Internal engineering docs (repo root of `docs/`)

- [mvp-spec.md](mvp-spec.md) — scope, phases, parity checklist (the WHAT)
- [decisions.md](decisions.md) — append-only decision log (ADR-style)
- [roadmap.md](roadmap.md) — prioritised backlog with provenance (the ORDER)

New user-facing documentation goes in the matching Diátaxis folder; the spec
and decision log stay at the root.
