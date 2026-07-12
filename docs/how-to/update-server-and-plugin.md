# Update the server and plugin

## Server

```sh
docker compose pull && docker compose up -d
```

The image is `ghcr.io/artislismanis/vault-sync-server` (`:latest`, or pin a
version via the `VAULT_SYNC_VERSION` variable). The running version surfaces
at `/healthz` and in `admin status`.

## Plugin

BRAT handles updates on each device: BRAT settings → "Check for updates"
(or enable auto-update at startup).

## Releasing (maintainer)

Tag a release as described in `CLAUDE.md` (`npm version patch -w plugin -w
server`, commit, bare-semver tag, push). GitHub Actions publishes the BRAT
release assets and the container image.

## Logs

`docker compose logs -f vault-sync` — structured JSON to stdout. Per-device
sync activity is also visible in the plugin (status bar icon → click).
