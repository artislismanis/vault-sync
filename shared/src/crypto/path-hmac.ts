import { getSodium } from './sodium';
import { KEY_BYTES } from './kdf';

// Paths are sensitive. The server indexes items by a deterministic keyed hash
// of the normalized path (keyed BLAKE2b under a key derived from the VMK) —
// non-reversible, but stable so clients can look items up by path.

const MAC_KEY_SUBKEY_ID = 1;
const MAC_KEY_CONTEXT = 'VSPATHMC'; // crypto_kdf context: exactly 8 chars

export function deriveMacKey(vmk: Uint8Array): Uint8Array {
  return getSodium().crypto_kdf_derive_from_key(KEY_BYTES, MAC_KEY_SUBKEY_ID, MAC_KEY_CONTEXT, vmk);
}

// Vault-relative paths must hash identically across platforms: forward
// slashes, NFC unicode (macOS reports NFD), no leading './' or '/'.
export function normalizePath(path: string): string {
  let p = path.normalize('NFC').replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/')) p = p.slice(1);
  return p;
}

export function pathHmac(macKey: Uint8Array, path: string): string {
  const sodium = getSodium();
  return sodium.to_hex(sodium.crypto_generichash(KEY_BYTES, normalizePath(path), macKey));
}
