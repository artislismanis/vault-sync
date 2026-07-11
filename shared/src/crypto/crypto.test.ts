import { beforeAll, describe, expect, it } from 'vitest';
import { initSodium, getSodium } from './sodium';
import { KdfParams, deriveKek } from './kdf';
import { seal, open, DecryptionError } from './aead';
import { createEnvelope, generateVmk, rewrapVmk, unwrapVmk, WrongPassphraseError } from './envelope';
import { deriveMacKey, normalizePath, pathHmac } from './path-hmac';

beforeAll(async () => {
  await initSodium();
});

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe('aead', () => {
  it('round-trips plaintext', () => {
    const key = getSodium().randombytes_buf(32);
    const sealed = seal(key, encode('# Note\ncontent'), 'ctx');
    expect(decode(open(key, sealed, 'ctx'))).toBe('# Note\ncontent');
  });

  it('produces distinct ciphertexts for identical plaintexts (random nonce)', () => {
    const key = getSodium().randombytes_buf(32);
    const a = seal(key, encode('same'));
    const b = seal(key, encode('same'));
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });

  it('fails closed on tampered ciphertext', () => {
    const key = getSodium().randombytes_buf(32);
    const sealed = seal(key, encode('secret'));
    sealed[sealed.length - 1]! ^= 0x01;
    expect(() => open(key, sealed)).toThrow(DecryptionError);
  });

  it('fails closed on wrong key and wrong aad', () => {
    const key = getSodium().randombytes_buf(32);
    const sealed = seal(key, encode('secret'), 'aad');
    expect(() => open(getSodium().randombytes_buf(32), sealed, 'aad')).toThrow(DecryptionError);
    expect(() => open(key, sealed, 'other-aad')).toThrow(DecryptionError);
  });
});

describe('kdf', () => {
  // Minimum-cost params: tests exercise correctness, not hardness.
  const fastKdf = (saltB64: string): KdfParams => ({
    algorithm: 'argon2id',
    opsLimit: getSodium().crypto_pwhash_OPSLIMIT_MIN,
    memLimitBytes: getSodium().crypto_pwhash_MEMLIMIT_MIN,
    saltB64,
  });

  it('is deterministic for same passphrase and salt, distinct otherwise', () => {
    const sodium = getSodium();
    const salt = sodium.to_base64(
      sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES),
      sodium.base64_variants.ORIGINAL,
    );
    const salt2 = sodium.to_base64(
      sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES),
      sodium.base64_variants.ORIGINAL,
    );
    const a = deriveKek('correct horse', fastKdf(salt));
    expect(deriveKek('correct horse', fastKdf(salt))).toEqual(a);
    expect(deriveKek('wrong horse', fastKdf(salt))).not.toEqual(a);
    expect(deriveKek('correct horse', fastKdf(salt2))).not.toEqual(a);
  });
});

describe('envelope', () => {
  // createEnvelope uses production KDF params (~64 MiB Argon2id) — slow but
  // worth exercising once for real.
  it('wraps and unwraps the VMK; wrong passphrase fails closed; rewrap preserves VMK', () => {
    const vmk = generateVmk();
    const vmkCopy = new Uint8Array(vmk);
    const envelope = createEnvelope(vmk, 'passphrase-1');

    expect(unwrapVmk(envelope, 'passphrase-1')).toEqual(vmkCopy);
    expect(() => unwrapVmk(envelope, 'passphrase-2')).toThrow(WrongPassphraseError);

    const rewrapped = rewrapVmk(envelope, 'passphrase-1', 'passphrase-2');
    expect(rewrapped.kdf.saltB64).not.toBe(envelope.kdf.saltB64);
    expect(unwrapVmk(rewrapped, 'passphrase-2')).toEqual(vmkCopy);
    expect(() => unwrapVmk(rewrapped, 'passphrase-1')).toThrow(WrongPassphraseError);
  }, 60_000);
});

describe('path hmac', () => {
  it('normalizes separators, prefixes, and unicode form', () => {
    expect(normalizePath('./notes\\daily/2026.md')).toBe('notes/daily/2026.md');
    expect(normalizePath('/notes/a.md')).toBe('notes/a.md');
    // NFD vs NFC "é"
    expect(normalizePath('café.md')).toBe(normalizePath('café.md'));
  });

  it('is deterministic per key and non-matching across keys', () => {
    const mac1 = deriveMacKey(generateVmk());
    const mac2 = deriveMacKey(generateVmk());
    expect(pathHmac(mac1, 'a/b.md')).toBe(pathHmac(mac1, './a/b.md'));
    expect(pathHmac(mac1, 'a/b.md')).not.toBe(pathHmac(mac2, 'a/b.md'));
    expect(pathHmac(mac1, 'a/b.md')).not.toBe(pathHmac(mac1, 'a/c.md'));
  });
});
