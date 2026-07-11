# Architecture

## Components

```
┌────────────────────┐        HTTPS (via reverse proxy / VPN)
│ Obsidian plugin    │◄──────────────────────────────┐
│ desktop + mobile   │   REST: auth, vaults, blobs,  │
│ (TypeScript)       │         revisions, history    │
│  - sync engine     │   WS:   change notifications  │
│  - crypto (E2EE)   │        (fallback: polling)    │
│  - merge (diff3)   │                               ▼
│  - settings UI     │                  ┌─────────────────────┐
└────────────────────┘                  │ sync server (Node/TS)│
                                        │  - auth (single user)│
        ┌────────────────┐              │  - revision DAG      │
        │ shared/ (TS)   │◄─ imported ─►│  - blob broker       │
        │ protocol types │   by both    │  - WS notifier       │
        │ schemas, crypto│              │  - retention pruner  │
        └────────────────┘              │  - admin CLI         │
                                        └──────────┬──────────┘
                                                   │ S3 API
                                        ┌──────────▼──────────┐
                                        │ S3-compatible store │
                                        │ (MinIO on NAS → any │
                                        │  cloud object store)│
                                        └─────────────────────┘
```

## Stack decisions

- **Language**: TypeScript everywhere. One protocol/schema definition in
  `shared/` consumed by server and plugin; richest ecosystem overlap with the
  Obsidian plugin API.
- **Server**: Node LTS. Framework: something boring and lightweight (Fastify
  or similar) + `ws`. Delivered as a single Docker image.
- **Plugin**: standard Obsidian plugin toolchain (esbuild bundle,
  manifest.json, versions.json). Must pass mobile constraints: no Node
  builtins, no Electron APIs; file I/O only via `app.vault` / `adapter`;
  crypto via WebCrypto or libsodium-wasm.
- **Storage**: exclusively through the S3 API so the store is swappable
  (MinIO → S3/R2/B2). No local-disk state that isn't reproducible or
  snapshotted to the bucket.

## Deployment model

See `docs/deployment.md` for the concrete Synology walkthrough (compose file,
reverse proxy, BRAT device setup).

- Primary: Docker container on Synology NAS (Container Manager), MinIO
  alongside. Compose file provided; nothing Synology-specific in the app.
- Server listens on plain HTTP; TLS is terminated by the owner's existing
  reverse proxy for public exposure, or traffic arrives via OpenVPN. Both must
  work; WebSocket must survive the reverse proxy (heartbeats, reconnect with
  backoff, silent downgrade to polling).
- Cloud migration path: same image on any container host; point at managed
  object storage; nothing else changes.

## Operational expectations

- Backups: the S3 bucket(s) are the complete server state. Documented restore
  procedure = restore bucket, start container.
- Admin: CLI inside the container (`docker exec`) for vault create/list,
  password reset, storage usage. No admin web UI in MVP.
- Logging: structured logs to stdout (Docker-native); sync activity also
  surfaced per-client in the plugin's status log.
- Config via environment variables only (12-factor): S3 endpoint/creds, port,
  auth secrets.

## Testing strategy (correctness core)

- Unit: crypto round-trips, path HMAC stability, merge cases (non-overlap,
  overlap, binary, delete-vs-edit).
- Integration: two simulated clients + server + MinIO (testcontainers or
  compose) driving convergence scenarios: offline edits, external edits,
  interrupted uploads, wrong passphrase fails closed.
- Property-style tests on the sync engine where cheap: random edit sequences
  on N clients must converge with no lost revisions.
