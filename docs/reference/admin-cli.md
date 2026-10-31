# Admin CLI reference

Every server administration task runs through one CLI. There is no web admin
UI by design.

**Invocation** — pick the form that matches where the server runs:

```sh
# In the deployed container (Synology/any Docker host):
docker compose exec vault-sync node dist/cli/admin.cjs <command> [args]

# In a dev checkout (reads S3 settings from ../.env if present):
npm run -w server admin -- <command> [args]
```

All examples below use the short form `admin <command>`. Running with no
command prints usage.

Commands that only read SQLite (`vault-list`, `device-*`) work even if the
bucket is unreachable; commands that touch storage (`status`, `vault-delete`,
`gc-blobs`, `prune`, `storage-usage`, `rebuild-index`) need valid `S3_*`
configuration.

**Machine-readable output** — the four read-only commands (`status`,
`vault-list`, `device-list`, `storage-usage`) accept `--json`, before or after
the command name. See [JSON output](#json-output).

---

## status

```
admin status [--json]
```

One-screen health overview: server version, bucket reachability, where the
active password hash comes from, vault/revision counts, device count, blob
storage total. Safe to run any time; read-only.

```
$ admin status
vault-sync server 0.0.10
bucket:   reachable
auth:     password hash from env
vaults:   2 (341 revision(s) total)
devices:  3 (last seen 2026-07-12T09:14:02.113Z)
storage:  128.4 MB in 512 blob object(s)
```

## set-password

```
admin set-password [password] [--stdin]
```

Change the account password. Persists the scrypt hash to
`DATA_DIR/account.json`, which **overrides** the `ACCOUNT_PASSWORD_HASH` env
var from then on. Takes effect on the next login — no restart. Devices that
are already logged in stay logged in (their tokens are independent); evict
one with `device-revoke`.

`--stdin` reads the password from standard input instead of an argument,
keeping it out of shell history:

```
$ echo 'correct horse battery staple' | admin set-password --stdin
password updated (DATA_DIR/account.json now overrides the env hash)
takes effect on the next login — no restart needed
already-logged-in devices stay logged in; evict with device-revoke
```

Recovery note: if the `DATA_DIR` volume is ever lost, the server falls back
to the env-var hash — i.e. the password you set at first deployment.

## hash-password

```
admin hash-password <password>
```

Print the `ACCOUNT_PASSWORD_HASH` value for `.env` / compose environment —
used at first deployment, before the server exists to run `set-password`.

```
$ admin hash-password 'my-account-password'
scrypt:16384:8:1:8gv7o6xkVGsHefPFTI+BQA==:uqOltNuo7xJJ...
```

The `:`-separated format is deliberate — it survives docker compose
interpolation, unlike crypt-style `$` separators.

## vault-list

```
admin vault-list [--json]
```

List vaults. Names are server-visible plaintext (docs/decisions.md
2026-07-13); a vault created before that migration shows `null` until a
device that knows the name reconnects and backfills it — cross-reference the
id with the plugin's settings screen ("Copy vault ID" button) in the
meantime.

```
$ admin vault-list
┌─────────┬────────────────────────────────────────┬─────────────┬────────────────────────────┐
│ (index) │ id                                     │ name        │ created_at                 │
├─────────┼────────────────────────────────────────┼─────────────┼────────────────────────────┤
│ 0       │ '3f2a91bc-7c1d-4e2a-9b0f-2d8f6a1c4e5b' │ 'Work Notes'│ '2026-07-11T18:03:11.402Z' │
└─────────┴────────────────────────────────────────┴─────────────┴────────────────────────────┘
```

## vault-delete

```
admin vault-delete <vaultId> [--yes]
```

**Permanently** delete a vault: every metadata sidecar, every ciphertext
blob, every index row. Without `--yes` it only previews:

```
$ admin vault-delete 3f2a91bc-7c1d-4e2a-9b0f-2d8f6a1c4e5b
vault 3f2a91bc-7c1d-4e2a-9b0f-2d8f6a1c4e5b (created 2026-07-11T18:03:11.402Z):
  42 file(s), 341 revision(s), 128.4 MB of blobs
this PERMANENTLY deletes all of it — re-run with --yes to proceed

$ admin vault-delete 3f2a91bc-7c1d-4e2a-9b0f-2d8f6a1c4e5b --yes
deleted vault 3f2a91bc-7c1d-4e2a-9b0f-2d8f6a1c4e5b: 341 revision(s), 725 object(s)
```

Deletion order is crash-safe: an interrupted run can simply be re-run. Local
copies of the vault on your devices are untouched. See
[../how-to/delete-a-vault.md](../how-to/delete-a-vault.md).

## rebuild-index

Rebuild the SQLite index from the bucket's metadata sidecars. The index is a
derived cache — this is the disaster-recovery command after restoring a
bucket backup, and safe to run whenever the index looks wrong.

```
$ admin rebuild-index
rebuilt index: 2 vault(s), 97 item(s), 341 revision(s)
```

Devices/tokens are deliberately not in the bucket; after a full `DATA_DIR`
loss every device just logs in again.

## gc-blobs

```
admin gc-blobs [--older-hours N]     # default 24
```

Delete blob chunk groups stranded by crashed/abandoned uploads (chunks with
no revision sidecar). Groups newer than the cutoff are left alone in case an
upload is still in flight.

```
$ admin gc-blobs
removed orphan 3f2a91bc-…/9d1e4f02-… (3 object(s))
gc-blobs: removed 1 orphan group(s), kept 509
```

## prune

```
admin prune --older-days N [--vault ID] [--yes]
```

Retention pruning: delete **non-head** revisions older than N days. Current
file contents (heads, including delete tombstones) are never touched.
Preview by default; `--yes` deletes.

```
$ admin prune --older-days 90
prune: would remove 118 non-head revision(s) older than 2026-04-13T10:00:00.000Z
re-run with --yes to delete
```

## storage-usage

```
admin storage-usage [--json]
```

Per-vault blob storage totals.

```
$ admin storage-usage
┌─────────┬────────────────────────────────────────┬─────────┬───────────┐
│ (index) │ vault                                  │ objects │ megabytes │
├─────────┼────────────────────────────────────────┼─────────┼───────────┤
│ 0       │ '3f2a91bc-7c1d-4e2a-9b0f-2d8f6a1c4e5b' │ 512     │ 128.4     │
└─────────┴────────────────────────────────────────┴─────────┴───────────┘
```

## device-list

```
admin device-list [--json]
```

List registered devices (each successful plugin login registers one). The
same names appear in the plugin's version-history view.

```
$ admin device-list
┌─────────┬──────────────┬───────────────┬────────────────────────────┬────────────────────────────┐
│ (index) │ id           │ name          │ created_at                 │ last_seen                  │
├─────────┼──────────────┼───────────────┼────────────────────────────┼────────────────────────────┤
│ 0       │ 'a41c9e77-…' │ 'work-laptop' │ '2026-07-11T18:00:41.977Z' │ '2026-07-12T09:14:02.113Z' │
│ 1       │ '0b82fd13-…' │ 'phone'       │ '2026-07-11T19:22:05.310Z' │ '2026-07-12T07:48:33.590Z' │
└─────────┴──────────────┴───────────────┴────────────────────────────┴────────────────────────────┘
```

## device-rename

```
admin device-rename <deviceId> <newName>
```

Rename a device (max 64 characters). Affects the device list and version
history labels. (Devices can also rename themselves from plugin settings.)

```
$ admin device-rename 0b82fd13-4c8a-4c11-b7f2-91e04d7a2c66 artis-iphone
renamed 0b82fd13-4c8a-4c11-b7f2-91e04d7a2c66: "phone" → "artis-iphone"
```

## device-revoke

```
admin device-revoke <deviceId>
```

Invalidate a device's token immediately (tokens never expire on their own).
The device's past revisions keep their history labels as "unknown device"
once revoked. Use for lost/retired devices.

```
$ admin device-revoke 0b82fd13-4c8a-4c11-b7f2-91e04d7a2c66
revoked 0b82fd13-4c8a-4c11-b7f2-91e04d7a2c66
```

---

## JSON output

`status`, `vault-list`, `device-list` and `storage-usage` take `--json` for
scripts and monitoring. `--json` may come before or after the command name:
`admin vault-list --json` and `admin --json vault-list` are the same.

With `--json` the command prints exactly one JSON document to stdout and
nothing else, and the text/table output is not printed. Without it, output is
unchanged.

- `vault-list`, `device-list` and `storage-usage` print an array of objects
  (`[]` when there is nothing to list). Keys are the table column names shown
  above, with the same values — `megabytes` is still rounded to one decimal,
  and a vault `name` that has not been backfilled is `null`.
- `status` prints an object:

  ```
  $ admin status --json
  {
    "version": "0.0.10",
    "bucket_reachable": true,
    "auth": "env",
    "vaults": 2,
    "revisions": 341,
    "devices": 3,
    "last_seen": "2026-07-12T09:14:02.113Z",
    "storage_bytes": 134637158,
    "storage_objects": 512
  }
  ```

  `auth` is where the active password hash comes from: `"file"`
  (`account.json`), `"env"`, or `"none"` (logins disabled). `last_seen` is
  `null` when no device is registered. Storage is in bytes here (unrounded).

**Errors.** If a command fails — invalid configuration, or the bucket is
unreachable — it exits non-zero, writes the error to stderr and leaves stdout
empty, so `admin status --json | jq …` never sees partial output. For
`status`, an unreachable bucket is a failure in `--json` mode (the text screen
shows `UNREACHABLE` instead), so `bucket_reachable` is always `true` in a
successful result.

**Other commands.** `--json` on any other command (including no command) exits
non-zero with a message on stderr, and does not run the command.
