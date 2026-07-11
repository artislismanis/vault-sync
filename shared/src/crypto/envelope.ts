import { getSodium } from './sodium';
import { KEY_BYTES, KdfParams, defaultKdfParams, deriveKek } from './kdf';
import { seal, open, DecryptionError } from './aead';

// Envelope encryption (docs/decisions.md): a random vault master key (VMK)
// encrypts all vault content; the VMK is wrapped by a KEK derived from the
// passphrase. Passphrase change = re-wrap 32 bytes. Authenticated unwrap is
// also the wrong-passphrase check — it fails closed by construction.

const VMK_WRAP_CONTEXT = 'vault-sync/vmk/v1';

export class WrongPassphraseError extends Error {
  constructor() {
    super('wrong passphrase (VMK unwrap failed authentication)');
    this.name = 'WrongPassphraseError';
  }
}

/** Server-side vault metadata: everything here is safe for the server to see. */
export interface VaultKeyEnvelope {
  kdf: KdfParams;
  wrappedVmkB64: string;
}

export function generateVmk(): Uint8Array {
  return getSodium().randombytes_buf(KEY_BYTES);
}

export function createEnvelope(vmk: Uint8Array, passphrase: string): VaultKeyEnvelope {
  const sodium = getSodium();
  const kdf = defaultKdfParams();
  const kek = deriveKek(passphrase, kdf);
  const wrapped = seal(kek, vmk, VMK_WRAP_CONTEXT);
  sodium.memzero(kek);
  return { kdf, wrappedVmkB64: sodium.to_base64(wrapped, sodium.base64_variants.ORIGINAL) };
}

export function unwrapVmk(envelope: VaultKeyEnvelope, passphrase: string): Uint8Array {
  const sodium = getSodium();
  const kek = deriveKek(passphrase, envelope.kdf);
  const wrapped = sodium.from_base64(envelope.wrappedVmkB64, sodium.base64_variants.ORIGINAL);
  try {
    return open(kek, wrapped, VMK_WRAP_CONTEXT);
  } catch (err) {
    if (err instanceof DecryptionError) throw new WrongPassphraseError();
    throw err;
  } finally {
    sodium.memzero(kek);
  }
}

/** Passphrase change: cheap re-wrap of the same VMK under a fresh KDF salt. */
export function rewrapVmk(
  envelope: VaultKeyEnvelope,
  oldPassphrase: string,
  newPassphrase: string,
): VaultKeyEnvelope {
  const vmk = unwrapVmk(envelope, oldPassphrase);
  try {
    return createEnvelope(vmk, newPassphrase);
  } finally {
    getSodium().memzero(vmk);
  }
}
