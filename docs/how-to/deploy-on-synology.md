# Deploy on Synology: Container Manager, reverse proxy, and storage options

A deeper Synology-specific companion to
[getting-started.md](../tutorials/getting-started.md) §3–4. Everything here is
deployment/docs only — the server itself has zero Synology-specific code
(`docs/decisions.md` 2026-07-11: "Rules out: Synology-specific code paths").
If a change here ever needs app-level code to work, it belongs in a decision
entry first, not a quiet addition to this file.

## Container Manager, as the primary click-through path

`deploy/docker-compose.yml` is deliberately `env_file:`-free — every setting is
a compose interpolation variable — specifically so Container Manager's
project UI (which has no first-class `.env` support) works without a
workaround:

1. Package Center → install **Container Manager**.
2. Create a deployment folder, e.g. `/volume1/docker/vault-sync/` — Synology
   convention is `/volume1/docker/<app>/...`, not a Linux-style path like
   `/opt/` or `/home/<user>/docker/`; Container Manager's file browser expects
   volume-rooted paths.
3. Project → Create → point at that folder, using the same
   `deploy/docker-compose.yml` from the repo.
4. When prompted for environment variables, set the required ones from
   `deploy/.env.example` (`S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
   `ACCOUNT_PASSWORD_HASH`). For the bundled-MinIO profile, also set
   `COMPOSE_PROFILES=bundled-minio`.
5. Named volumes (`vault-sync-data`, and `minio-data` if bundled) are
   Portainer/Container-Manager-safe as-is — no relative host paths to adjust.

**Port conflicts**: DSM itself listens on 5000/5001 (HTTP/HTTPS) and often
80/443 if Web Station or the reverse proxy is active. `deploy/docker-compose.yml`
already publishes the app on `${PUBLISH_PORT:-8080}`, which avoids the clash;
if you bundle MinIO, its console (9001) and API (9000) ports are unlikely to
collide but check `Control Panel → Network → Network Interface` if unsure.

**Image pinning**: the compose file defaults to
`ghcr.io/artislismanis/vault-sync-server:${VAULT_SYNC_VERSION:-latest}`. For a
NAS that runs unattended for long stretches, pin `VAULT_SYNC_VERSION` to a
specific release rather than tracking `latest`, and update deliberately via
[update-server-and-plugin.md](update-server-and-plugin.md).

## Reverse proxy: DSM's built-in proxy + the WebSocket header

Already covered step-by-step in
[getting-started.md §4](../tutorials/getting-started.md#4-https-via-reverse-proxy):
`Control Panel → Login Portal → Advanced → Reverse Proxy`, plus the
**Custom Header → WebSocket** rule that's easy to miss (without it, `/ws`
fails silently and every client falls back to polling — sync still works, just
without near-instant push). Two points worth restating on their own:

- The WebSocket header rule and the ≥60s proxy timeout are the two most
  common causes of "sync works but feels slow" reports on Synology — check
  both first before assuming an application bug.
- For a publicly reachable cert, use DNS-01 (`acme.sh` with its
  `synology_dsm` deploy hook) rather than a self-signed/internal CA — Obsidian
  on Android and iOS only trusts the system CA store, so an internal CA fails
  with `Trust anchor for certification path not found` even after installing
  the root cert on the device. Full reasoning in
  [getting-started.md](../tutorials/getting-started.md#tls-internal-cas-do-not-work-on-mobile).

## Storage: MinIO stays the recommended path; Synology C2 is a validated cloud alternative

The server talks to storage exclusively through the S3 API with
`forcePathStyle: true` (`server/src/store/s3.ts`) — any endpoint that speaks
real path-style S3 (`HeadBucket`, `Put`/`Get`/`DeleteObject`,
`ListObjectsV2`) works. Two options, no code changes either way:

- **MinIO on the NAS** (existing or bundled via the compose profile) —
  recommended default, matches `docs/decisions.md`'s "MinIO already on NAS"
  rationale.
- **Synology C2 Object Storage** — Synology's own S3-compatible *cloud*
  service. DSM has no built-in on-box S3-compatible object store of its own
  (Cloud Sync talks to various providers including C2, but that's a sync
  target, not a server-side storage API); C2 is relevant here only as a
  **cloud swap-in** for `S3_ENDPOINT`/`S3_ACCESS_KEY`/`S3_SECRET_KEY` if you
  ever move the bucket off-NAS, matching the "cloud migration path" already
  described in `docs/explanation/architecture.md`. Verify path-style access
  and bucket policy support before switching a production vault over — this
  hasn't been tested against C2 specifically.

WebDAV is not an option: the storage contract is strictly S3
(`docs/explanation/architecture.md`: "Storage access goes through the
S3-compatible interface exclusively"), and there is no WebDAV store
implementation.

## Notifications via DSM webhooks

DSM 7's `Control Panel → Notification → Push Service → Manage Webhooks`
supports custom JSON webhooks (Discord, Synology Chat, or any endpoint that
accepts a POST). This is a candidate delivery mechanism for the
security-event notification idea in [roadmap.md](../roadmap.md#non-technical-threads)
(new-device-authorized / failed-login pings) — noted here as the
Synology-side half of that idea; the app-side trigger doesn't exist yet.

## What's deliberately not here

No Synology API calls, no DSM package, no dependency on Synology-specific
storage or auth services in the server or plugin. If tighter integration ever
seems to require any of that, treat it as a scope change and add a
`docs/decisions.md` entry before writing code.
