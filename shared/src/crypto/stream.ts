import { getSodium } from './sodium';

// Blob format v2: chunked streaming encryption via crypto_secretstream
// (XChaCha20-Poly1305 with a ratcheting key). Memory stays O(chunk) on both
// ends — the whole point (docs/explanation/sync-protocol.md "Blob format v2").
//
// - 8 MiB plaintext chunks, each +17 bytes AEAD overhead.
// - The 24-byte stream header travels in revision metadata (streamHeaderB64,
//   not secret — nonce material).
// - AD binds every chunk to its revision id, so the server cannot splice one
//   revision's chunks under another's metadata.
// - The ratchet makes reordered/omitted/replayed chunks fail authentication;
//   truncation is caught by the mandatory FINAL tag on the last chunk.
//   Callers MUST treat a missing FINAL as failure — never a partial success.

export const CHUNK_BYTES = 8 * 1024 * 1024;
export const CHUNK_OVERHEAD_BYTES = 17; // crypto_secretstream_..._ABYTES

const AD_PREFIX = 'vault-sync/content/v2/';

export class StreamDecryptionError extends Error {
  constructor(message = 'stream chunk failed authentication (wrong key, tampered, or reordered)') {
    super(message);
    this.name = 'StreamDecryptionError';
  }
}

export function chunkCountFor(plaintextBytes: number): number {
  return Math.max(1, Math.ceil(plaintextBytes / CHUNK_BYTES));
}

export interface StreamEncryptor {
  headerB64: string;
  /** Encrypt the next chunk. Chunks must be pushed in order, exactly once. */
  pushChunk(plaintext: Uint8Array, final: boolean): Uint8Array;
}

export function createStreamEncryptor(contentKey: Uint8Array, revisionId: string): StreamEncryptor {
  const sodium = getSodium();
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(contentKey);
  const ad = AD_PREFIX + revisionId;
  return {
    headerB64: sodium.to_base64(header, sodium.base64_variants.ORIGINAL),
    pushChunk(plaintext, final) {
      return sodium.crypto_secretstream_xchacha20poly1305_push(
        state,
        plaintext,
        ad,
        final
          ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
          : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
      );
    },
  };
}

export interface StreamDecryptor {
  /** Decrypt the next chunk; throws StreamDecryptionError on any failure. */
  pullChunk(ciphertext: Uint8Array): { plaintext: Uint8Array; final: boolean };
}

export function createStreamDecryptor(
  contentKey: Uint8Array,
  revisionId: string,
  headerB64: string,
): StreamDecryptor {
  const sodium = getSodium();
  let state: ReturnType<typeof sodium.crypto_secretstream_xchacha20poly1305_init_pull>;
  try {
    const header = sodium.from_base64(headerB64, sodium.base64_variants.ORIGINAL);
    state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, contentKey);
  } catch {
    throw new StreamDecryptionError('invalid stream header');
  }
  const ad = AD_PREFIX + revisionId;
  return {
    pullChunk(ciphertext) {
      let result: { message: Uint8Array; tag: number } | false | null;
      try {
        result = getSodium().crypto_secretstream_xchacha20poly1305_pull(state, ciphertext, ad);
      } catch {
        throw new StreamDecryptionError();
      }
      if (!result) throw new StreamDecryptionError();
      return {
        plaintext: result.message,
        final: result.tag === getSodium().crypto_secretstream_xchacha20poly1305_TAG_FINAL,
      };
    },
  };
}
