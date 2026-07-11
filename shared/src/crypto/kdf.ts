import { getSodium } from './sodium';
import type { KdfParams } from '../protocol/rest';

export type { KdfParams };

export const KEY_BYTES = 32;

// KDF params (shape owned by protocol/rest.ts) are stored plaintext in vault
// metadata server-side so they can be raised for new vaults without breaking
// old ones. Salt is not secret.

// Defaults chosen for Obsidian mobile webviews: 64 MiB memory keeps low-end
// devices out of OOM territory; unlock is a rare interactive operation.
export function defaultKdfParams(): KdfParams {
  const sodium = getSodium();
  return {
    algorithm: 'argon2id',
    opsLimit: 3,
    memLimitBytes: 64 * 1024 * 1024,
    saltB64: sodium.to_base64(
      sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES),
      sodium.base64_variants.ORIGINAL,
    ),
  };
}

/** Derive the key-encryption key (KEK) from the vault passphrase. */
export function deriveKek(passphrase: string, params: KdfParams): Uint8Array {
  const sodium = getSodium();
  const salt = sodium.from_base64(params.saltB64, sodium.base64_variants.ORIGINAL);
  return sodium.crypto_pwhash(
    KEY_BYTES,
    passphrase,
    salt,
    params.opsLimit,
    params.memLimitBytes,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}
