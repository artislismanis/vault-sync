# Deployment: Synology NAS

Getting the sync server running on a Synology NAS behind HTTPS, and the
plugin onto devices via BRAT. The server itself is host-generic — everything
Synology-specific lives in this document.

## Prerequisites

- Container Manager installed (Package Center).
- SSH enabled: Control Panel → Terminal & SNMP → Enable SSH.
- A folder for the deployment, e.g. `/volume1/docker/vault-sync/`.
- Either an existing S3-compatible store (MinIO) on the NAS, or use the
  bundled-MinIO profile below.

## 1. Storage

**Path A — existing MinIO (recommended if you already run one):**

1. MinIO console → Buckets → create bucket `vault-sync`
   (dedicated bucket; don't reuse a dev bucket).
2. Access Keys → create a key pair; restrict it to the `vault-sync` bucket if
   you use MinIO policies. Note endpoint (`http://<nas-ip>:9000`), key, secret.

**Path B — bundled MinIO:** skip prep; the compose profile below starts a
private MinIO alongside the server and creates the bucket automatically.

## 2. Configure

```sh
ssh <user>@<nas-ip>
mkdir -p /volume1/docker/vault-sync && cd /volume1/docker/vault-sync
curl -LO https://raw.githubusercontent.com/artislismanis/vault-sync/main/deploy/docker-compose.yml
curl -L -o .env https://raw.githubusercontent.com/artislismanis/vault-sync/main/deploy/.env.example
vi .env    # fill in S3 settings (option A or B)
```

Generate the account password hash and paste it into `.env`:

```sh
docker run --rm ghcr.io/artislismanis/vault-sync-server:latest \
  node dist/cli/admin.cjs hash-password '<your-account-password>'
```

## 3. Start

```sh
docker compose up -d                            # path A (external S3)
docker compose --profile bundled-minio up -d    # path B (bundled MinIO)
docker compose logs -f vault-sync               # expect "Server listening"
```

Alternatively use Container Manager → Project → create from the same folder.

Verify on the LAN: `curl http://<nas-ip>:8080/healthz` → `{"ok":true,"s3":"ok"}`.
If `s3` is `unreachable`, fix `S3_*` in `.env` and `docker compose up -d` again.

## 4. HTTPS via reverse proxy

The server listens on plain HTTP; TLS terminates at the proxy. With
Synology's built-in reverse proxy:

1. Control Panel → Login Portal → Advanced → Reverse Proxy → Create:
   - Source: HTTPS, `sync.<your-domain>`, port 443 (HSTS optional).
   - Destination: HTTP, `localhost`, `8080`.
2. Same rule → Custom Header → Create → **WebSocket** (adds the
   `Upgrade`/`Connection` headers — without this, `/ws` silently fails and
   clients fall back to polling).
3. Advanced Settings → proxy timeouts ≥ 60s (WebSocket heartbeats).
4. Certificate: Control Panel → Security → Certificate → add Let's Encrypt
   cert for `sync.<your-domain>`, assign it to the reverse-proxy entry.
5. DNS: point `sync.<your-domain>` at your public IP (or use split DNS to the
   NAS LAN IP when at home); forward port 443 if exposing publicly.

Generic nginx equivalent:

```nginx
location / {
  proxy_pass http://nas-ip:8080;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 120s;
}
```

Verify from a phone browser: `https://sync.<your-domain>/healthz`.

## 5. Install the plugin via BRAT

On every device (desktop and mobile):

1. Obsidian → Community plugins → install and enable **BRAT**.
2. BRAT settings → "Add beta plugin" → `artislismanis/vault-sync` → latest
   version → enable **Vault Sync**.
3. Updates: BRAT → "Check for updates" (or enable auto-update at startup).

Onboarding (first device): Vault Sync settings → server URL
`https://sync.<your-domain>` + device name → Log in → Create vault (name +
E2EE passphrase). Additional devices: Log in → Refresh vault list → select
vault → enter passphrase → Unlock.

## 6. Two-device convergence test

1. Desktop: create/edit a note → within ~2s it lands on the server (watch
   `docker compose logs -f vault-sync`).
2. Second device: note appears (instant while open via WebSocket; on mobile,
   foreground the app / run "Sync now").
3. Edit different parts of the same note on both devices while one is
   offline → reconnect → both edits merge; overlapping edits produce a
   `... (conflict YYYY-MM-DD device).md` sibling, nothing lost.
4. Delete a note on one device → moves to `.trash` on the others.

## Ongoing operations

- **Update server**: `docker compose pull && docker compose up -d`.
- **Update plugin**: tag a release (see CLAUDE.md); BRAT picks it up.
- **Admin**: `docker compose exec vault-sync node dist/cli/admin.cjs vault-list`
  (also `rebuild-index`, `hash-password`).
- **Backup**: the S3 bucket is the complete server state. Restore = restore
  bucket → start container → `rebuild-index`. The `./data` volume is an
  expendable cache.
- **Logs**: `docker compose logs` (structured JSON to stdout).
