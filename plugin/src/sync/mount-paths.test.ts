import { describe, expect, it } from 'vitest';
import {
  isUnderAnyMount,
  joinMount,
  normalizeMountPath,
  stripMount,
  validateMountPath,
} from './mount-paths';

describe('normalizeMountPath', () => {
  it('cleans slashes and whitespace', () => {
    expect(normalizeMountPath('  Reference  ')).toBe('Reference');
    expect(normalizeMountPath('/Shared/Reference/')).toBe('Shared/Reference');
    expect(normalizeMountPath('Shared//Reference')).toBe('Shared/Reference');
    expect(normalizeMountPath('Shared\\Reference')).toBe('Shared/Reference');
  });

  it('applies NFC (macOS NFD folder names)', () => {
    const nfd = 'Café'; // e + combining accent
    expect(normalizeMountPath(nfd)).toBe('Café');
  });

  it('rejects empty, vault root, and dot-leading segments', () => {
    expect(normalizeMountPath('')).toBeNull();
    expect(normalizeMountPath('   ')).toBeNull();
    expect(normalizeMountPath('/')).toBeNull();
    expect(normalizeMountPath('.obsidian')).toBeNull();
    expect(normalizeMountPath('.obsidian/plugins')).toBeNull();
    expect(normalizeMountPath('Shared/.hidden')).toBeNull();
    expect(normalizeMountPath('../escape')).toBeNull();
    expect(normalizeMountPath('a/../b')).toBeNull();
  });
});

describe('validateMountPath', () => {
  it('rejects overlap in either direction', () => {
    expect(validateMountPath('Shared', ['Shared/Reference'])).toMatch(/overlaps/);
    expect(validateMountPath('Shared/Reference', ['Shared'])).toMatch(/overlaps/);
    expect(validateMountPath('Reference', ['Reference'])).toMatch(/overlaps/);
  });

  it('allows siblings and near-name prefixes', () => {
    // "Ref" is NOT a prefix of "Reference" in path terms.
    expect(validateMountPath('Ref', ['Reference'])).toBeNull();
    expect(validateMountPath('Reference', ['Ref'])).toBeNull();
    expect(validateMountPath('Shared/A', ['Shared/B'])).toBeNull();
    expect(validateMountPath('Anything', [])).toBeNull();
  });
});

describe('stripMount / joinMount round-trip', () => {
  it('strips and joins deep paths', () => {
    expect(stripMount('Reference', 'Reference/notes/x.md')).toBe('notes/x.md');
    expect(joinMount('Reference', 'notes/x.md')).toBe('Reference/notes/x.md');
    expect(stripMount('Shared/Reference', 'Shared/Reference/x.md')).toBe('x.md');
    expect(
      joinMount('Shared/Reference', stripMount('Shared/Reference', 'Shared/Reference/x.md')!),
    ).toBe('Shared/Reference/x.md');
  });

  it('returns null outside the mount (including near-name folders and the root itself)', () => {
    expect(stripMount('Reference', 'Other/x.md')).toBeNull();
    expect(stripMount('Reference', 'ReferenceBooks/x.md')).toBeNull();
    expect(stripMount('Reference', 'Reference')).toBeNull(); // the folder, not a file
  });
});

describe('isUnderAnyMount', () => {
  it('matches mount roots and children, not near-names', () => {
    const mounts = ['Reference', 'Shared/Team'];
    expect(isUnderAnyMount('Reference', mounts)).toBe(true);
    expect(isUnderAnyMount('Reference/x.md', mounts)).toBe(true);
    expect(isUnderAnyMount('Shared/Team/a/b.md', mounts)).toBe(true);
    expect(isUnderAnyMount('ReferenceBooks/x.md', mounts)).toBe(false);
    expect(isUnderAnyMount('Shared/Other/x.md', mounts)).toBe(false);
    expect(isUnderAnyMount('anything.md', [])).toBe(false);
  });
});
