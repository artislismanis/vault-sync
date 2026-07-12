import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Account credential store: `admin set-password` persists the scrypt hash to
// DATA_DIR/account.json, which OVERRIDES the ACCOUNT_PASSWORD_HASH env var
// (docs/decisions.md 2026-07-12). Env stays the bootstrap/recovery value —
// in Docker the env is baked into the stack, so a file the CLI can rewrite is
// the only way password changes work without redeploying. Deliberately NOT in
// SQLite (the index must stay rebuildable-from-bucket) and NOT in the bucket
// (keeps credentials out of backups, like session tokens).

const ACCOUNT_FILE = 'account.json';

interface AccountFile {
  passwordHashV1?: string;
}

export function readStoredPasswordHash(dataDir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, ACCOUNT_FILE), 'utf8')) as AccountFile;
    return typeof parsed.passwordHashV1 === 'string' ? parsed.passwordHashV1 : null;
  } catch {
    return null; // missing or unreadable file → fall back to env
  }
}

export function writeStoredPasswordHash(dataDir: string, hash: string): void {
  mkdirSync(dataDir, { recursive: true });
  const target = join(dataDir, ACCOUNT_FILE);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ passwordHashV1: hash })}\n`);
  renameSync(tmp, target); // atomic: never a half-written credential file
}

/** The live hash: file (set via CLI) wins over env (bootstrap). */
export function resolvePasswordHash(dataDir: string, envHash?: string): string | null {
  return readStoredPasswordHash(dataDir) ?? envHash ?? null;
}

export function passwordHashSource(dataDir: string, envHash?: string): 'file' | 'env' | 'none' {
  if (readStoredPasswordHash(dataDir) !== null) return 'file';
  return envHash ? 'env' : 'none';
}
