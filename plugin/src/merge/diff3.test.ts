import { describe, expect, it } from 'vitest';
import { threeWayMerge } from './diff3';

const base = ['# Note', '', 'line one', 'line two', 'line three'].join('\n');

describe('threeWayMerge', () => {
  it('auto-merges non-overlapping edits from both sides', () => {
    const local = base.replace('line one', 'line one (edited locally)');
    const remote = base.replace('line three', 'line three (edited remotely)');
    const result = threeWayMerge(base, local, remote);
    expect(result).toEqual({
      ok: true,
      merged: [
        '# Note',
        '',
        'line one (edited locally)',
        'line two',
        'line three (edited remotely)',
      ].join('\n'),
    });
  });

  it('reports conflict on overlapping edits, merging nothing', () => {
    const local = base.replace('line two', 'line two (local)');
    const remote = base.replace('line two', 'line two (remote)');
    expect(threeWayMerge(base, local, remote)).toEqual({ ok: false });
  });

  it('takes the only changed side when the other is untouched', () => {
    const remote = base.replace('line two', 'line two (remote)');
    expect(threeWayMerge(base, base, remote)).toEqual({ ok: true, merged: remote });
  });

  it('treats identical concurrent edits as agreement, not conflict', () => {
    const both = base.replace('line two', 'line two (same edit)');
    expect(threeWayMerge(base, both, both)).toEqual({ ok: true, merged: both });
  });
});
