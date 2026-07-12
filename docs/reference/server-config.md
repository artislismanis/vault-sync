# Server configuration reference

Configuration is environment-variables only (12-factor). In the deploy
compose file these arrive as interpolation variables — see
`deploy/.env.example` for a ready-to-fill template.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `S3_ENDPOINT` | yes | — | S3-compatible endpoint, e.g. `http://minio:9000` |
| `S3_ACCESS_KEY` | yes | — | S3 access key |
| `S3_SECRET_KEY` | yes | — | S3 secret key |
| `S3_BUCKET` | yes | — | Bucket holding all server state |
| `S3_REGION` | no | `us-east-1` | Region (MinIO ignores it) |
| `ACCOUNT_PASSWORD_HASH` | no* | — | scrypt hash from `admin hash-password`; without it (and without a stored hash) logins are disabled |
| `PORT` | no | `8080` | HTTP listen port |
| `HOST` | no | `0.0.0.0` | Listen address |
| `LOG_LEVEL` | no | `info` | Fastify log level (`silent`…`trace`) |
| `DATA_DIR` | no | `./data` | Local state: SQLite index, `account.json` |

\* Required for first login unless `admin set-password` has been run.

Deploy-compose extras (interpolation only, not read by the app):
`PUBLISH_PORT` (host port mapping), `COMPOSE_PROFILES=bundled-minio`
(optional private MinIO), `VAULT_SYNC_VERSION` (image tag pinning).

## The account password: env vs `account.json`

Two sources, checked in order:

1. **`DATA_DIR/account.json`** — written by `admin set-password`; wins when
   present.
2. **`ACCOUNT_PASSWORD_HASH` env var** — the bootstrap value from first
   deployment.

The file overrides the env var so password changes work without redeploying
the stack. The startup log states which source is active; `admin status`
shows it too. If the `DATA_DIR` volume is lost, the server falls back to the
env hash (the original password). File format:

```json
{"passwordHashV1":"scrypt:16384:8:1:<saltB64>:<hashB64>"}
```

The hash format uses `:` separators deliberately — crypt-style `$` gets
mangled by compose interpolation.

## Data locations

| Where | What | Loss impact |
|---|---|---|
| S3 bucket | All vault state: metadata sidecars + ciphertext blobs | **Total** — this is the thing to back up |
| `DATA_DIR/index.db` | SQLite index (derived cache of the bucket) | None — `admin rebuild-index` recreates it; devices re-login |
| `DATA_DIR/account.json` | Password hash set via CLI | Falls back to env hash |

See [../how-to/back-up-and-restore.md](../how-to/back-up-and-restore.md).
