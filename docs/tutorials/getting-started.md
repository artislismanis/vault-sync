# Getting started: deploy the server and sync your first vault

A complete first-time walkthrough: run the sync server (Synology NAS example)
behind HTTPS, install the plugin via BRAT, and verify two devices converge.
The server itself is host-generic — everything Synology-specific lives here,
not in the app.

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

All configuration is compose **interpolation variables** (`${S3_ENDPOINT}` etc.
in `deploy/docker-compose.yml`) — there is deliberately no `env_file:`, so the
same compose file works with the docker CLI, Container Manager, and Portainer.
The variables are listed in `deploy/.env.example`; the required ones are
`S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `ACCOUNT_PASSWORD_HASH`
(plus optional `S3_BUCKET`, `PUBLISH_PORT`, `LOG_LEVEL`). Full variable
reference: [../reference/server-config.md](../reference/server-config.md).

First generate the account password hash (any machine with docker):

```sh
docker run --rm ghcr.io/artislismanis/vault-sync-server:latest \
  node dist/cli/admin.cjs hash-password '<your-account-password>'
```

The output looks like `scrypt:16384:8:1:<base64>:<base64>` and is safe to put
in env vars and `.env` files as-is. (To change the password later without
touching env vars, see
[../how-to/change-the-account-password.md](../how-to/change-the-account-password.md).)

## 3. Start — pick ONE of these

**Portainer (Stacks):**

1. Stacks → Add stack → name `vault-sync`.
2. Build method **Repository**: URL `https://github.com/artislismanis/vault-sync`,
   compose path `deploy/docker-compose.yml` — or **Web editor**: paste the
   file's contents.
3. Under **Environment variables**, add the required variables (Advanced mode
   lets you paste `KEY=value` lines straight from `.env.example`).
4. Deploy. For bundled MinIO, add `COMPOSE_PROFILES=bundled-minio` as an
   extra environment variable (Portainer doesn't expose compose profiles in
   its UI).

**docker compose over SSH:**

```sh
ssh <user>@<nas-ip>
mkdir -p /volume1/docker/vault-sync && cd /volume1/docker/vault-sync
curl -LO https://raw.githubusercontent.com/artislismanis/vault-sync/main/deploy/docker-compose.yml
curl -L -o .env https://raw.githubusercontent.com/artislismanis/vault-sync/main/deploy/.env.example
vi .env                                         # fill in the variables
docker compose up -d                            # path A (external S3)
docker compose --profile bundled-minio up -d    # path B (bundled MinIO)
docker compose logs -f vault-sync               # expect "Server listening"
```

(`.env` caveat: docker compose interpolates unquoted values — single-quote
any value containing `$`.)

**Container Manager:** Project → Create → point at the same folder; set the
variables in the project's environment settings when prompted.

Verify on the LAN: `curl http://<nas-ip>:8080/healthz` → `{"ok":true,"s3":"ok"}`.
If `s3` is `unreachable`, fix the `S3_*` variables and redeploy. The startup
log warns explicitly if no account password is configured, and states whether
the active hash comes from the env var or from `admin set-password`.

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

### TLS: internal CAs do NOT work on mobile

Obsidian on Android trusts only the **system** CA store (Android 7+ apps
ignore user-installed CAs unless they opt in, and Obsidian doesn't); iOS is
similarly strict. A self-managed/internal CA certificate on the sync endpoint
fails with `Trust anchor for certification path not found` — installing the
root CA on the device does not help.

Use a publicly trusted certificate instead. The internal-only pattern that
works: real domain + split-horizon DNS (`sync.<domain>` → NAS LAN IP
internally) + Let's Encrypt via **DNS-01** challenge, so no port ever opens
to the internet. On Synology, `acme.sh` with your DNS provider's API and its
`synology_dsm` deploy hook automates renewal; Caddy/Traefik/nginx do DNS-01
natively. Fallback for testing: plain HTTP over VPN (`http://<nas-ip>:8080`)
— REST works, though WebSocket push may not.

## 5. Install the plugin via BRAT

On every device (desktop and mobile):

1. Obsidian → Community plugins → install and enable **BRAT**.
2. BRAT settings → "Add beta plugin" → `artislismanis/vault-sync` → latest
   version → enable **Vault Sync**.
3. Updates: BRAT → "Check for updates" (or enable auto-update at startup).

Onboarding (first device): Vault Sync settings → server URL
`https://sync.<your-domain>` + device name → Log in → Create vault (name +
E2EE passphrase). Additional devices: Log in → Refresh vault list → select
vault → enter passphrase → Unlock. Vaults you've unlocked before show their
decrypted name in the list; others show only a creation date until unlocked
(names are end-to-end encrypted).

## 6. Two-device convergence test

1. Desktop: create/edit a note → within ~2s it lands on the server (watch
   `docker compose logs -f vault-sync`).
2. Second device: note appears (instant while open via WebSocket; on mobile,
   foreground the app / run "Sync now").
3. Edit different parts of the same note on both devices while one is
   offline → reconnect → both edits merge; overlapping edits produce a
   `... (conflict YYYY-MM-DD device).md` sibling, nothing lost.
4. Delete a note on one device → moves to `.trash` on the others.

## Where next

- Day-2 operations (updates, backup, devices, vault cleanup): the guides in
  [../how-to/](../how-to/).
- Every admin command with examples:
  [../reference/admin-cli.md](../reference/admin-cli.md).
