# Sync Protocol & Encryption Design

Status: design agreed 2026-07-11 — all previously OPEN items resolved; see
docs/decisions.md for rationale. Update both files together if anything here
changes.

## Trust model

- The server is honest-but-curious infrastructure: it stores, versions, and
  notifies, but must never be able to read content, file names, or paths.
- Clients hold the vault passphrase. A future web client is just another
  client that is given the key by the user.
- Server-visible metadata is limited to: account identity, vault IDs, opaque
  item IDs, ciphertext sizes, version graph, timestamps. Accept that sizes and
  edit timing leak; do not leak more.

## Encryption

- Envelope encryption: a random 256-bit **vault master key (VMK)** encrypts
  all vault content; the VMK is wrapped (AEAD) by a **KEK** derived from the
  per-vault passphrase via Argon2id (libsodium `crypto_pwhash`, sumo build;
  default 64 MiB / ops 3 — mobile-webview-safe). KDF params + salt stored
  server-side with vault metadata (not secret); the wrapped VMK is opaque
  ciphertext.
- AEAD is **XChaCha20-Poly1305 via libsodium-wasm** (`shared/src/crypto/`).
  Argon2id forces libsodium into the bundle anyway; 192-bit nonces make
  random nonces unconditionally safe with no cross-device counter state. Wire
  format: `nonce || ciphertext+tag`; wasm is base64-embedded in the JS, so it
  bundles into the plugin's single `main.js`.
- Paths are sensitive: encrypt the path as part of item metadata. For server
  lookups, index items by a keyed BLAKE2b hash of the NFC-normalized path
  under a MAC key derived from the VMK (deterministic, non-reversible).
- Passphrase verification: authenticated unwrap of the VMK **is** the check —
  a wrong passphrase fails AEAD authentication and fails closed by
  construction. No separate known-value blob needed.
- Key rotation: passphrase change = unwrap + re-wrap the VMK under a fresh
  salt (milliseconds, no content touched — `rewrapVmk`). Full VMK rotation
  (key compromise) remains client-side re-encrypt-everything: supported,
  documented as expensive, not optimized.

## Data model (server-side, all content opaque)

- `vault`: id, encrypted name (encrypted under the VMK — the server and admin
  CLI see only vault id / created_at / usage), KDF params/salt, wrapped VMK,
  retention policy, created_at.
- `item`: id, vault_id, path_hmac, encrypted_path, deleted flag.
- `revision`: id, item_id, parent_revision_id(s), ciphertext blob ref, size,
  client_device_id, client_mtime, server_receive_time.
  Revisions form a small DAG per item; concurrent parents indicate a conflict
  the client must resolve.
- Blobs live in S3-compatible storage keyed by **revision id**. No content
  addressing: random-nonce E2EE makes ciphertext dedup worthless, and
  blob↔revision keeps pruning trivial (prefix delete, no refcounting).
  Convergent encryption stays ruled out — it leaks plaintext-equality.
- **Blob format v2 (chunked, since 0.0.4):** content is encrypted with
  libsodium `crypto_secretstream` (XChaCha20-Poly1305, ratcheting key) in
  8 MiB plaintext chunks, each stored as its own object
  (`blobs/{vaultId}/{revisionId}/{seq}`, zero-padded). The 24-byte stream
  header rides in revision metadata (`streamHeaderB64`, not secret) with the
  chunk count. AD binds every chunk to its revision id (no server-side
  content splicing). The ratchet rejects reordered/omitted/replayed chunks;
  the mandatory FINAL tag on the last chunk catches truncation — clients
  hard-abort on any failure, never write partial content. Memory on both
  ends is O(chunk) for crypto/transport; the client-side whole-file buffer
  remains (Obsidian's vault API has no ranged reads), which is what the
  selective-sync size cap guards. Upload order: all chunks PUT first, then
  revision metadata — the server verifies the exact chunk key set before
  accepting; stranded chunks from crashed uploads are collected by
  `admin gc-blobs`. Pre-0.0.4 single-object blobs (v1, no `chunks` field)
  remain readable.
- Metadata persistence: **write-ahead sidecars + rebuildable SQLite index.**
  Every accepted write is first PUT to the bucket as an immutable JSON
  sidecar (`meta/vaults/{vaultId}.json`, `meta/{vaultId}/items/{itemId}.json`,
  `meta/{vaultId}/revisions/{revisionId}.json`), then indexed in SQLite on a
  local volume, then acked. SQLite is purely derived and expendable;
  `admin rebuild-index` reconstructs it from a bucket scan. "Back up the
  bucket" is therefore a complete, self-consistent backup with no snapshot
  lag window.

## Sync flow

1. **Session**: client authenticates (account password → token). Opens
   WebSocket for change notifications; falls back to interval polling if WS
   can't be established (VPNs, proxies, mobile).
2. **Reconcile** (on connect, on foreground, periodically on desktop): client
   compares its local index (path, mtime, size, content hash, last-synced
   revision) against a full scan of the vault folder — catching external edits —
   and against the server's revision heads for the vault.
3. **Pull**: fetch unseen revisions, decrypt, apply. If local file also changed
   since its base revision → merge path (below).
4. **Push**: encrypt and upload changed files as new revisions, citing the
   parent revision. Server appends; it never rejects on conflict — concurrent
   heads are represented in the DAG and resolved client-side.
5. **Delete**: tombstone revisions; propagate; history retains prior content.

Client local state (plugin data dir, via Obsidian adapter APIs): sync index +
base-version cache per file, enabling three-way merge. Hybrid policy: base
**plaintext cached locally** for merge-eligible text files under a size cap
(default 1 MB) — offline edits are the common conflict case and must merge
without connectivity; hash + base revision id only for binaries/oversized
(they never text-merge), with fetch-and-decrypt from history as the fallback
for cache misses. The cache itself is never synced.

## Conflict resolution (client-side only)

- Three-way merge (base, local, remote) for markdown/text using **node-diff3**
  (true diff3 semantics, pure JS, zero deps, line granularity), wrapped behind
  `plugin/src/merge/diff3.ts` so it stays swappable. diff-match-patch rejected:
  archived, and fuzzy patch application can silently misplace hunks.
- Non-overlapping hunks → auto-merge, push merged revision with both parents.
- Overlapping hunks or binary files → keep remote at path, write local as
  `Name (conflict YYYY-MM-DD device).md` sibling; both revisions retained.
- Never discard either side silently under any circumstance.

## Version history

- Default: retain every revision. Per-vault configurable policy (e.g. keep all
  N days, then daily, then weekly). Pruning runs server-side on ciphertext —
  it only needs the revision DAG, not content.
- Plugin UI: per-file history list → view (decrypt) → restore as new revision.

## Selective sync & ignores

- Client-side filter before push: category toggles (image/audio/video/pdf/
  other) + size cap. Filtered files are simply never uploaded.
- Size cap (implemented 0.0.4): `maxFileSizeMB` per device, default 100 MB on
  mobile / unlimited on desktop. Oversized files (local or remote) are marked
  excluded in the sync index — never pushed, pulled, or deleted. Raising the
  cap re-includes them via the normal merge/conflict path. This is the mobile
  OOM guard: a synced file must fit in webview memory at least once.
- Glob ignore patterns: same mechanism; cheap if the filter layer is designed
  as a predicate chain — attempt in MVP, drop to phase 2 if it drags.
- When a previously synced file becomes excluded: **stop updating** (matches
  Obsidian Sync). Remote keeps its last revision + history; the sync index
  marks the file `excluded` so reconciliation doesn't misread divergence as a
  delete or a new file. Exclusion suppresses delete propagation in both
  directions; re-inclusion re-enters the normal merge/conflict path against
  the last remote head. Exclusion is client-side policy only — invisible to
  the server (which couldn't evaluate filters under E2EE anyway).

## Non-goals in the protocol

- No server-side merge, diff, dedup of plaintext, or search — impossible and
  undesired under E2EE.
- No cross-vault or cross-user sharing semantics.
