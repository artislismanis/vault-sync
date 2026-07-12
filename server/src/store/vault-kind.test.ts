import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVaultRequestSchema } from '@vault-sync/shared';
import { openDb, Db } from './db';
import { indexVault, rebuildIndex, writeVaultSidecar, VaultRecord } from './metadata-log';
import { memoryStore } from '../test-util/memory-store';

// Vault kind ('vault' vs 'folder') distinguishes full vaults from folder
// shares so the plugin's dropdowns offer the right candidates. It must survive
// index → rebuild-from-bucket, and sidecars written before v3 (no kind field)
// must rebuild as 'vault' — the index stays lossless.

const base = (id: string, kind?: VaultRecord['kind']): VaultRecord => ({
  id,
  encryptedNameB64: 'b3BhcXVl',
  kdfJson: '{}',
  wrappedVmkB64: 'b3BhcXVl',
  createdAt: '2026-07-01T00:00:00.000Z',
  ...(kind ? { kind } : {}),
});

const kindOf = (db: Db, id: string): string =>
  (db.prepare('SELECT kind FROM vault WHERE id = ?').get(id) as { kind: string }).kind;

describe('vault kind', () => {
  let dataDir: string;
  let db: Db;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'vault-sync-kind-'));
    db = openDb(dataDir);
  });
  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists an explicit folder kind through index', () => {
    indexVault(db, base('00000000-0000-4000-8000-000000000001', 'folder'));
    expect(kindOf(db, '00000000-0000-4000-8000-000000000001')).toBe('folder');
  });

  it('defaults a kind-less record to vault on index', () => {
    indexVault(db, base('00000000-0000-4000-8000-000000000002'));
    expect(kindOf(db, '00000000-0000-4000-8000-000000000002')).toBe('vault');
  });

  it('rebuilds kind from the bucket, defaulting legacy sidecars to vault', async () => {
    const store = memoryStore();
    await writeVaultSidecar(store, base('00000000-0000-4000-8000-000000000003', 'folder'));
    // Legacy sidecar: JSON with no kind field, as written before v3.
    await store.put(
      'meta/vaults/00000000-0000-4000-8000-000000000004.json',
      JSON.stringify(base('00000000-0000-4000-8000-000000000004')),
    );

    await rebuildIndex(store, db);

    expect(kindOf(db, '00000000-0000-4000-8000-000000000003')).toBe('folder');
    expect(kindOf(db, '00000000-0000-4000-8000-000000000004')).toBe('vault');
  });

  it('defaults kind to vault when a create request omits it', () => {
    const parsed = createVaultRequestSchema.parse({
      encryptedNameB64: 'b3BhcXVl',
      kdf: { algorithm: 'argon2id', opsLimit: 1, memLimitBytes: 1, saltB64: 'x' },
      wrappedVmkB64: 'b3BhcXVl',
    });
    expect(parsed.kind).toBe('vault');
  });
});
