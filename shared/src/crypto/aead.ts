import { getSodium } from './sodium';

// XChaCha20-Poly1305. 192-bit nonces make random nonces unconditionally safe —
// no counter state to coordinate across devices (see docs/decisions.md).
// Wire format: nonce (24 bytes) || ciphertext+tag.

export class DecryptionError extends Error {
  constructor(message = 'AEAD decryption failed (wrong key or tampered ciphertext)') {
    super(message);
    this.name = 'DecryptionError';
  }
}

export function seal(key: Uint8Array, plaintext: Uint8Array, aad?: string): Uint8Array {
  const sodium = getSodium();
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad ?? null,
    null,
    nonce,
    key,
  );
  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.length);
  return out;
}

export function open(key: Uint8Array, sealed: Uint8Array, aad?: string): Uint8Array {
  const sodium = getSodium();
  const nonceBytes = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  if (sealed.length <= nonceBytes) {
    throw new DecryptionError('sealed message too short');
  }
  const nonce = sealed.subarray(0, nonceBytes);
  const ciphertext = sealed.subarray(nonceBytes);
  try {
    return getSodium().crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      aad ?? null,
      nonce,
      key,
    );
  } catch {
    throw new DecryptionError();
  }
}
