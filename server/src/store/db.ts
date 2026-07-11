import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// Local SQLite index — a DERIVED view of the bucket's metadata sidecars,
// rebuildable at any time via `admin rebuild-index`. Never the source of
// truth (docs/decisions.md); losing this file must lose nothing.

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vault (
  id            TEXT PRIMARY KEY,
  encrypted_name_b64 TEXT NOT NULL,
  kdf_json      TEXT NOT NULL,
  wrapped_vmk_b64 TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS item (
  id            TEXT PRIMARY KEY,
  vault_id      TEXT NOT NULL REFERENCES vault(id),
  path_hmac     TEXT NOT NULL,
  encrypted_path_b64 TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (vault_id, path_hmac)
);
CREATE TABLE IF NOT EXISTS revision (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES item(id),
  parent_ids_json TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  device_id     TEXT NOT NULL,
  client_mtime  TEXT NOT NULL,
  server_received_at TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  chunks        INTEGER,
  stream_header_b64 TEXT
);
CREATE INDEX IF NOT EXISTS revision_item ON revision(item_id);
CREATE TABLE IF NOT EXISTS device (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  last_seen     TEXT NOT NULL
);
`;

export type Db = Database.Database;

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'index.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version < 1) {
    db.exec(SCHEMA);
  } else if (version < 2) {
    // v2: blob format v2 metadata (chunk count + secretstream header).
    db.exec('ALTER TABLE revision ADD COLUMN chunks INTEGER;');
    db.exec('ALTER TABLE revision ADD COLUMN stream_header_b64 TEXT;');
  }
  if (version < SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
  return db;
}
