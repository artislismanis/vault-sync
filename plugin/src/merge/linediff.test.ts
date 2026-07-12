import { describe, expect, it } from 'vitest';
import { DiffLine, hasChanges, isDiffable, lineDiff } from './linediff';

const render = (diff: DiffLine[]) =>
  diff.map((l) => `${{ ctx: ' ', add: '+', del: '-', gap: '~' }[l.kind]}${l.text}`);

describe('lineDiff', () => {
  it('collapses identical inputs to a single gap', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const diff = lineDiff(text, text);
    expect(hasChanges(diff)).toBe(false);
    expect(diff).toEqual([{ kind: 'gap', text: '⋯ 10 unchanged lines' }]);
  });

  it('shows a pure insertion with context', () => {
    const diff = lineDiff('a\nb\nc', 'a\nb\nNEW\nc');
    expect(render(diff)).toEqual([' a', ' b', '+NEW', ' c']);
    expect(hasChanges(diff)).toBe(true);
  });

  it('shows a pure deletion with context', () => {
    const diff = lineDiff('a\nGONE\nb', 'a\nb');
    expect(render(diff)).toEqual([' a', '-GONE', ' b']);
  });

  it('shows a changed block as delete-then-add', () => {
    const diff = lineDiff('a\nold\nb', 'a\nnew\nb');
    expect(render(diff)).toEqual([' a', '-old', '+new', ' b']);
  });

  it('collapses long unchanged stretches, keeping context lines at hunk edges', () => {
    const middle = Array.from({ length: 20 }, (_, i) => `mid ${i}`);
    const oldText = ['start-old', ...middle, 'end-old'].join('\n');
    const newText = ['start-new', ...middle, 'end-new'].join('\n');
    const rendered = render(lineDiff(oldText, newText, 3));
    expect(rendered).toEqual([
      '-start-old',
      '+start-new',
      ' mid 0',
      ' mid 1',
      ' mid 2',
      '~⋯ 14 unchanged lines',
      ' mid 17',
      ' mid 18',
      ' mid 19',
      '-end-old',
      '+end-new',
    ]);
  });

  it('does not collapse short common runs', () => {
    const diff = lineDiff('x\na\nb\nc\ny', 'X\na\nb\nc\nY');
    expect(render(diff)).toEqual(['-x', '+X', ' a', ' b', ' c', '-y', '+Y']);
  });

  it('handles empty sides', () => {
    expect(render(lineDiff('', 'a\nb'))).toEqual(['-', '+a', '+b']);
    expect(hasChanges(lineDiff('', ''))).toBe(false);
  });
});

describe('isDiffable', () => {
  it('caps by line count on either side', () => {
    const big = 'x\n'.repeat(50);
    expect(isDiffable(big, 'small', 51)).toBe(true);
    expect(isDiffable(big, 'small', 20)).toBe(false);
    expect(isDiffable('small', big, 20)).toBe(false);
  });
});
