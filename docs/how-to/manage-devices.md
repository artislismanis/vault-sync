# Manage devices

Each plugin login registers a device on the server: a name, an id, and a
login token. Device names show up in the plugin's version history ("edited on
work-laptop") and in conflict filenames.

## See what's registered

```sh
docker compose exec vault-sync node dist/cli/admin.cjs device-list
```

Shows id, name, registration date, and last-seen time per device.

## Rename a device

Preferred: on the device itself — plugin settings → **Device name**. The new
name syncs to the server immediately and appears in other devices' version
history.

From the server (e.g. for a device you can't reach):

```sh
docker compose exec vault-sync node dist/cli/admin.cjs \
  device-rename <deviceId> <newName>
```

## Kick out a lost or retired device

Login tokens never expire on their own, so revoke explicitly:

```sh
docker compose exec vault-sync node dist/cli/admin.cjs device-revoke <deviceId>
```

The device's next sync fails with 401; logging in again (with the account
password) would register it as a new device. Revoking does not delete any
synced data — history entries from that device remain, labeled
"unknown device".

Full command reference: [../reference/admin-cli.md](../reference/admin-cli.md).
