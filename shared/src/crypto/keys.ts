import { getSodium } from './sodium';
import { KEY_BYTES } from './kdf';
import { deriveMacKey } from './path-hmac';
import { seal, open } from './aead';

// Independent subkeys derived from the VMK via crypto_kdf (BLAKE2b), one per
// purpose: content encryption, path encryption, path MAC. Domain separation
// comes from distinct 8-char contexts.

const CONTENT_CONTEXT = 'VSCONTNT';
const PATH_ENC_CONTEXT = 'VSPATHEN';
const CONTENT_AAD = 'vault-sync/content/v1';
const PATH_AAD = 'vault-sync/path/v1';

export interface VaultKeys {
  vmk: Uint8Array;
  contentKey: Uint8Array;
  pathKey: Uint8Array;
  macKey: Uint8Array;
}

export function deriveVaultKeys(vmk: Uint8Array): VaultKeys {
  const sodium = getSodium();
  return {
    vmk,
    contentKey: sodium.crypto_kdf_derive_from_key(KEY_BYTES, 1, CONTENT_CONTEXT, vmk),
    pathKey: sodium.crypto_kdf_derive_from_key(KEY_BYTES, 1, PATH_ENC_CONTEXT, vmk),
    macKey: deriveMacKey(vmk),
  };
}

export function encryptContent(keys: VaultKeys, plaintext: Uint8Array): Uint8Array {
  return seal(keys.contentKey, plaintext, CONTENT_AAD);
}

export function decryptContent(keys: VaultKeys, sealed: Uint8Array): Uint8Array {
  return open(keys.contentKey, sealed, CONTENT_AAD);
}

export function encryptPath(keys: VaultKeys, path: string): string {
  const sodium = getSodium();
  const sealed = seal(keys.pathKey, sodium.from_string(path), PATH_AAD);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

export function decryptPath(keys: VaultKeys, encryptedPathB64: string): string {
  const sodium = getSodium();
  const sealed = sodium.from_base64(encryptedPathB64, sodium.base64_variants.ORIGINAL);
  return sodium.to_string(open(keys.pathKey, sealed, PATH_AAD));
}

/** Encrypted vault name uses the path key (it's the same kind of secret). */
export const encryptVaultName = encryptPath;
export const decryptVaultName = decryptPath;
