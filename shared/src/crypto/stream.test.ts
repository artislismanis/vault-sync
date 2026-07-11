import { beforeAll, describe, expect, it } from 'vitest';
import { initSodium, getSodium } from './sodium';
import {
  chunkCountFor,
  CHUNK_BYTES,
  createStreamDecryptor,
  createStreamEncryptor,
  StreamDecryptionError,
} from './stream';

beforeAll(async () => {
  await initSodium();
});

const REV = '00000000-0000-4000-8000-000000000001';

function encryptAll(key: Uint8Array, chunks: Uint8Array[], revisionId = REV) {
  const enc = createStreamEncryptor(key, revisionId);
  return {
    headerB64: enc.headerB64,
    ciphertexts: chunks.map((c, i) => enc.pushChunk(c, i === chunks.length - 1)),
  };
}

describe('secretstream blob format v2', () => {
  it('round-trips multi-chunk content byte-identically', () => {
    const key = getSodium().randombytes_buf(32);
    const chunks = [
      getSodium().randombytes_buf(1024),
      getSodium().randombytes_buf(2048),
      getSodium().randombytes_buf(7),
    ];
    const { headerB64, ciphertexts } = encryptAll(key, chunks);
    const dec = createStreamDecryptor(key, REV, headerB64);
    ciphertexts.forEach((c, i) => {
      const { plaintext, final } = dec.pullChunk(c);
      expect(plaintext).toEqual(chunks[i]);
      expect(final).toBe(i === ciphertexts.length - 1);
    });
  });

  it('fails closed on reordered chunks', () => {
    const key = getSodium().randombytes_buf(32);
    const { headerB64, ciphertexts } = encryptAll(key, [
      new TextEncoder().encode('one'),
      new TextEncoder().encode('two'),
      new TextEncoder().encode('three'),
    ]);
    const dec = createStreamDecryptor(key, REV, headerB64);
    expect(() => dec.pullChunk(ciphertexts[1]!)).toThrow(StreamDecryptionError);
  });

  it('fails closed on tampered chunk and wrong revision binding', () => {
    const key = getSodium().randombytes_buf(32);
    const { headerB64, ciphertexts } = encryptAll(key, [new TextEncoder().encode('data')]);

    const tampered = new Uint8Array(ciphertexts[0]!);
    tampered[0]! ^= 0x01;
    expect(() => createStreamDecryptor(key, REV, headerB64).pullChunk(tampered)).toThrow(
      StreamDecryptionError,
    );

    // Same ciphertext under a different revision id (server splice attempt).
    const otherRev = '00000000-0000-4000-8000-000000000002';
    expect(() => createStreamDecryptor(key, otherRev, headerB64).pullChunk(ciphertexts[0]!)).toThrow(
      StreamDecryptionError,
    );
  });

  it('exposes truncation via the missing FINAL tag', () => {
    const key = getSodium().randombytes_buf(32);
    const { headerB64, ciphertexts } = encryptAll(key, [
      new TextEncoder().encode('first'),
      new TextEncoder().encode('last'),
    ]);
    const dec = createStreamDecryptor(key, REV, headerB64);
    // Truncated stream: consumer sees final=false on what the server claims
    // is the last chunk — callers must hard-abort on that.
    expect(dec.pullChunk(ciphertexts[0]!).final).toBe(false);
  });

  it('handles empty files as a single FINAL chunk', () => {
    const key = getSodium().randombytes_buf(32);
    const { headerB64, ciphertexts } = encryptAll(key, [new Uint8Array(0)]);
    const dec = createStreamDecryptor(key, REV, headerB64);
    const { plaintext, final } = dec.pullChunk(ciphertexts[0]!);
    expect(plaintext.byteLength).toBe(0);
    expect(final).toBe(true);
  });

  it('computes chunk counts', () => {
    expect(chunkCountFor(0)).toBe(1);
    expect(chunkCountFor(1)).toBe(1);
    expect(chunkCountFor(CHUNK_BYTES)).toBe(1);
    expect(chunkCountFor(CHUNK_BYTES + 1)).toBe(2);
  });
});
