import { describe, expect, it } from 'vitest';
import { canonicalKey, findCanonicalPathCollisions } from './canonical-path';

const nfc = 'caf\u00e9.md'; // \u00e9 = e-acute as one codepoint
const nfd = 'cafe\u0301.md'; // e + combining acute accent (U+0301)
const nfc2 = 'na\u00efve.md'; // \u00ef = i-diaeresis as one codepoint
const nfd2 = 'nai\u0308ve.md'; // i + combining diaeresis (U+0308)

describe('canonicalKey', () => {
  it('normalizes NFD to NFC', () => {
    expect(canonicalKey(nfc)).toBe(canonicalKey(nfd));
  });

  it('normalizes backslashes to forward slashes', () => {
    expect(canonicalKey('a\\b.md')).toBe('a/b.md');
  });
});

describe('findCanonicalPathCollisions', () => {
  it('finds no collisions among distinct paths', () => {
    expect(findCanonicalPathCollisions(['a.md', 'b.md'])).toEqual([]);
  });

  it('reports NFC/NFD spellings of the same path as a collision', () => {
    const collisions = findCanonicalPathCollisions([nfc, nfd, 'other.md']);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.paths.sort()).toEqual([nfc, nfd].sort());
  });

  it('does not treat an exact duplicate string as a collision', () => {
    expect(findCanonicalPathCollisions(['a.md', 'a.md'])).toEqual([]);
  });

  it('finds multiple independent collisions', () => {
    const collisions = findCanonicalPathCollisions([nfc, nfd, nfc2, nfd2, 'unrelated.md']);
    expect(collisions).toHaveLength(2);
  });
});
