import { describe, expect, it } from 'vitest';
import { originalPathFor, findConflictGroups } from './conflict-detect';

describe('originalPathFor', () => {
  it('recovers the original path from a conflict sibling', () => {
    expect(originalPathFor('Notes/a (conflict 2026-08-24 laptop).md')).toBe('Notes/a.md');
  });

  it('handles a numeric counter suffix', () => {
    expect(originalPathFor('a (conflict 2026-08-24 laptop 2).md')).toBe('a.md');
  });

  it('handles an extensionless file', () => {
    expect(originalPathFor('a (conflict 2026-08-24 laptop)')).toBe('a');
  });

  it('returns null for a non-conflict path', () => {
    expect(originalPathFor('Notes/a.md')).toBeNull();
  });

  it('returns null for a filename that merely contains the substring', () => {
    expect(originalPathFor('Notes/(conflict resolution notes).md')).toBeNull();
  });

  it('preserves the folder', () => {
    expect(originalPathFor('Deep/Nested/a (conflict 2026-08-24 phone).md')).toBe(
      'Deep/Nested/a.md',
    );
  });
});

describe('findConflictGroups', () => {
  it('finds no groups when nothing conflicts', () => {
    expect(findConflictGroups(['a.md', 'b.md'])).toEqual([]);
  });

  it('groups a single sibling with its original', () => {
    const paths = ['a.md', 'a (conflict 2026-08-24 laptop).md', 'b.md'];
    expect(findConflictGroups(paths)).toEqual([
      { original: 'a.md', siblings: ['a (conflict 2026-08-24 laptop).md'] },
    ]);
  });

  it('groups multiple siblings under one original', () => {
    const paths = ['a.md', 'a (conflict 2026-08-24 laptop).md', 'a (conflict 2026-08-25 phone).md'];
    const groups = findConflictGroups(paths);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.siblings).toHaveLength(2);
  });

  it('does not group a sibling whose original is missing from the scan', () => {
    const paths = ['a (conflict 2026-08-24 laptop).md', 'b.md'];
    expect(findConflictGroups(paths)).toEqual([]);
  });

  it('finds multiple independent groups', () => {
    const paths = [
      'a.md',
      'a (conflict 2026-08-24 laptop).md',
      'b.md',
      'b (conflict 2026-08-24 phone).md',
      'c.md',
    ];
    expect(findConflictGroups(paths)).toHaveLength(2);
  });
});
