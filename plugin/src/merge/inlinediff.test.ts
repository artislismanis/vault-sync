import { describe, expect, it } from 'vitest';
import {
  addInlineMarks,
  InlineLine,
  MAX_INLINE_LINE_LENGTH,
  MIN_INLINE_SIMILARITY,
  Range,
  splitByMarks,
} from './inlinediff';
import { DiffLine, lineDiff } from './linediff';

const del = (text: string): DiffLine => ({ kind: 'del', text });
const add = (text: string): DiffLine => ({ kind: 'add', text });

const changed = (text: string, marks: Range[] | undefined) =>
  splitByMarks(text, marks)
    .filter((p) => p.changed)
    .map((p) => p.text);

/** Marked pair of a single del/add replacement. */
const pair = (oldText: string, newText: string): [InlineLine, InlineLine] => {
  const [d, a] = addInlineMarks([del(oldText), add(newText)]);
  return [d!, a!];
};

describe('addInlineMarks pairing and highlighting', () => {
  it('highlights only the changed word on both sides', () => {
    const [d, a] = pair(
      'The quick brown fox jumps over the lazy dog',
      'The quick lazy fox jumps over the lazy dog',
    );
    expect(changed(d.text, d.marks)).toEqual(['brown']);
    expect(changed(a.text, a.marks)).toEqual(['lazy']);
  });

  it('marks pure insertions and deletions on the side that has them', () => {
    const [d, a] = pair('hello world', 'hello big world');
    expect(d.marks).toBeUndefined();
    expect(changed(a.text, a.marks)).toEqual(['big ']);
  });

  it('pairs a run in order and leaves surplus deletes unmarked', () => {
    const out = addInlineMarks([
      del('alpha one two'),
      del('beta three four'),
      del('gamma leftover'),
      add('alpha one 2'),
      add('beta 3 four'),
    ]);
    expect(changed(out[0]!.text, out[0]!.marks)).toEqual(['two']);
    expect(changed(out[1]!.text, out[1]!.marks)).toEqual(['three']);
    expect(out[2]!.marks).toBeUndefined();
    expect(changed(out[3]!.text, out[3]!.marks)).toEqual(['2']);
    expect(changed(out[4]!.text, out[4]!.marks)).toEqual(['3']);
  });

  it('leaves surplus adds unmarked', () => {
    const out = addInlineMarks([
      del('same text here v1'),
      add('same text here v2'),
      add('brand new line'),
    ]);
    expect(out[0]!.marks).toBeDefined();
    expect(out[1]!.marks).toBeDefined();
    expect(out[2]!.marks).toBeUndefined();
  });

  it('pairs within each hunk separately and passes ctx/gap through', () => {
    const input: DiffLine[] = [
      { kind: 'ctx', text: 'keep' },
      del('one two three'),
      add('one 2 three'),
      { kind: 'gap', text: '⋯ 9 unchanged lines' },
      del('four five six'),
      add('four 5 six'),
    ];
    const out = addInlineMarks(input);
    expect(out[0]).toBe(input[0]);
    expect(out[3]).toBe(input[3]);
    expect(changed(out[1]!.text, out[1]!.marks)).toEqual(['two']);
    expect(changed(out[4]!.text, out[4]!.marks)).toEqual(['five']);
    expect(changed(out[5]!.text, out[5]!.marks)).toEqual(['5']);
  });

  it('works on real lineDiff output and does not mutate its input', () => {
    const diff = lineDiff('a\nthe cat sat\nb', 'a\nthe cut sat\nb');
    const snapshot = JSON.parse(JSON.stringify(diff));
    const out = addInlineMarks(diff);
    expect(diff).toEqual(snapshot);
    expect(out.map((l) => l.kind)).toEqual(diff.map((l) => l.kind));
    expect(out.map((l) => l.text)).toEqual(diff.map((l) => l.text));
    expect(changed(out[1]!.text, out[1]!.marks)).toEqual(['a']);
    expect(changed(out[2]!.text, out[2]!.marks)).toEqual(['u']);
  });
});

describe('similarity threshold', () => {
  it('shows dissimilar pairs as whole-line changes', () => {
    const [d, a] = pair('old', 'new');
    expect(d.marks).toBeUndefined();
    expect(a.marks).toBeUndefined();
  });

  it('uses a 0.5 default: below it whole-line, at it highlighted', () => {
    expect(MIN_INLINE_SIMILARITY).toBe(0.5);
    // 2 shared of 6 + 6 graphemes → 0.33
    expect(pair('abcdef', 'abxyzw')[0].marks).toBeUndefined();
    // 3 shared of 6 + 6 graphemes → exactly 0.5
    expect(pair('abcdef', 'abcxyz')[0].marks).toBeDefined();
  });

  it('leaves shared characters inside a replaced word unhighlighted', () => {
    // 'brown' → 'red' shares only the r; it stays unmarked (no coalescing).
    const [d] = pair('The quick brown fox jumps', 'The quick red fox jumps');
    expect(changed(d.text, d.marks)).toEqual(['b', 'own']);
  });

  it('is configurable and inclusive at the boundary', () => {
    // abcdef vs abcxyz share 3 of 6 each → similarity exactly 0.5 → highlighted.
    const [d] = addInlineMarks([del('abcdef'), add('abcxyz')], { minSimilarity: 0.5 }) as [
      InlineLine,
    ];
    expect(changed(d.text, d.marks)).toEqual(['def']);
    const [d2] = addInlineMarks([del('abcdef'), add('abcxyz')], { minSimilarity: 0.51 });
    expect(d2!.marks).toBeUndefined();
  });
});

describe('grapheme integrity', () => {
  const boundaries = (text: string) => {
    const set = new Set<number>([text.length]);
    for (const s of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
      set.add(s.index);
    }
    return set;
  };
  const expectWhole = (line: InlineLine) => {
    const ok = boundaries(line.text);
    for (const [s, e] of line.marks ?? []) {
      expect(ok.has(s)).toBe(true);
      expect(ok.has(e)).toBe(true);
    }
  };

  it('never splits ZWJ sequences, flags or skin-tone emoji', () => {
    const family = '👨‍👩‍👧‍👦';
    const [d, a] = pair(`hello ${family} world today`, `hello 👩‍💻 world today`);
    expect(changed(d.text, d.marks)).toEqual([family]);
    expect(changed(a.text, a.marks)).toEqual(['👩‍💻']);

    const [fd, fa] = pair('go 🇬🇧 now please', 'go 🇫🇷 now please');
    expect(changed(fd.text, fd.marks)).toEqual(['🇬🇧']);
    expect(changed(fa.text, fa.marks)).toEqual(['🇫🇷']);

    const [sd, sa] = pair('wave 👋 hello there', 'wave 👋🏽 hello there');
    expectWhole(sd);
    expectWhole(sa);
    expect(changed(sa.text, sa.marks)).toEqual(['👋🏽']);
  });

  it('keeps a base character and its combining mark together', () => {
    const [d, a] = pair('café au lait', 'cafe au lait');
    expect(changed(d.text, d.marks)).toEqual(['é']);
    expect(changed(a.text, a.marks)).toEqual(['e']);
    expectWhole(d);
    expectWhole(a);
  });

  it('treats NFC and NFD forms of the same text as equal, with no marks', () => {
    const [d, a] = pair('café au lait', 'café au lait');
    expect(d.marks).toBeUndefined();
    expect(a.marks).toBeUndefined();
  });

  it('highlights a real edit next to NFC/NFD-different text without splitting it', () => {
    const [d, a] = pair('café one two', 'café one 2');
    expect(changed(d.text, d.marks)).toEqual(['two']);
    expect(changed(a.text, a.marks)).toEqual(['2']);
    expectWhole(d);
    expectWhole(a);
  });
});

describe('size limits', () => {
  it('falls back to whole-line for a 100,000+ character line, quickly', () => {
    const long = 'word '.repeat(25_000); // 125,000 chars
    const start = performance.now();
    const [d, a] = pair(long + 'old', long + 'new');
    expect(performance.now() - start).toBeLessThan(500);
    expect(d.text.length).toBeGreaterThanOrEqual(100_000);
    expect(d.marks).toBeUndefined();
    expect(a.marks).toBeUndefined();
  });

  it('applies the per-line limit to either side, inclusive at the limit', () => {
    const at = 'x'.repeat(MAX_INLINE_LINE_LENGTH - 1);
    expect(pair(at + 'a', at + 'b')[0].marks).toBeDefined();
    expect(pair(at + 'aa', at + 'b')[0].marks).toBeUndefined();
    expect(pair(at + 'a', at + 'bb')[0].marks).toBeUndefined();
  });

  it('charges pairs rejected as too dissimilar to the work budget', () => {
    // Each dissimilar pair's middle is 40×40 = 1,600 cells; the budget fits two.
    const similarOld = `${'shared prefix '.repeat(4)}${'abcdefghijkl'}${' shared suffix'.repeat(4)}`;
    const similarNew = `${'shared prefix '.repeat(4)}${'mnopqrstuvwx'}${' shared suffix'.repeat(4)}`;
    const lines = (): DiffLine[] => [
      del(`s ${'a'.repeat(40)} e`),
      del(`s ${'a'.repeat(40)} e`),
      del(`s ${'a'.repeat(40)} e`),
      del(similarOld),
      add(`s ${'b'.repeat(40)} e`),
      add(`s ${'b'.repeat(40)} e`),
      add(`s ${'b'.repeat(40)} e`),
      add(similarNew),
    ];
    // Control: with room to spare the similar pair is highlighted.
    const roomy = addInlineMarks(lines(), { maxCells: 1_000_000 });
    expect(roomy[3]!.marks).toBeDefined();
    expect(roomy[0]!.marks).toBeUndefined(); // dissimilar → whole-line

    // Two dissimilar pairs spend 3,200 of 3,300; the third and the similar
    // pair (12×12 = 144 > 100 left) fall back even though they were rejected
    // or accepted on merit before.
    const out = addInlineMarks(lines(), { maxCells: 3_300 });
    expect(out.map((l) => l.marks !== undefined)).toEqual(Array(8).fill(false));
  });

  it('runs the quadratic diff for a pair at the budget edge and charges for it', () => {
    const rnd = (seed: number, n: number) => {
      let x = seed;
      return Array.from({ length: n }, () => {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        return 'abcdefghij'[x % 10];
      }).join('');
    };
    const side = 500; // 500² = 250k = MAX_INLINE_CELLS
    const similarOld = `${'p'.repeat(100)}${'abcdefghij'.repeat(10)}${'q'.repeat(100)}`;
    const similarNew = `${'p'.repeat(100)}${'klmnopqrst'.repeat(10)}${'q'.repeat(100)}`;
    const input = [del(rnd(1, side)), del(similarOld), add(rnd(2, side)), add(similarNew)];

    const start = performance.now();
    const out = addInlineMarks(input);
    expect(performance.now() - start).toBeLessThan(1_000);
    // The random pair's diff ran and spent the budget, so the 100×100 similar
    // pair behind it falls back...
    expect(out[1]!.marks).toBeUndefined();
    // ...whereas on its own it is highlighted.
    expect(addInlineMarks([del(similarOld), add(similarNew)])[0]!.marks).toBeDefined();
  });

  it('keeps repetitive text, the slowest shape for the LCS, within a safe time', () => {
    // Adversarial for the diff: every grapheme matches many on the other side.
    // 500×500 = 250k cells is the most the budget lets through.
    const start = performance.now();
    addInlineMarks([del(`b${'a'.repeat(499)}`), add(`${'a'.repeat(499)}b`)]);
    expect(performance.now() - start).toBeLessThan(1_000);

    // 700×700 = 490k cells: this took ~640 ms to diff; now it never runs.
    const t1 = performance.now();
    const [d] = pair('ab'.repeat(350), 'ba'.repeat(350));
    expect(d.marks).toBeUndefined();
    expect(performance.now() - t1).toBeLessThan(100);
  });

  it('stops segmenting once the budget is spent', () => {
    let calls = 0;
    const base = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const segmenter = {
      segment(input: string) {
        calls++;
        return base.segment(input);
      },
    };
    const lines: DiffLine[] = [];
    for (let i = 0; i < 20; i++) lines.push(del(`s ${'a'.repeat(40)} e`));
    for (let i = 0; i < 20; i++) lines.push(add(`s ${'b'.repeat(40)} e`));
    addInlineMarks(lines, { segmenter, maxCells: 1_600 }); // one dissimilar pair
    expect(calls).toBe(2); // one pair segmented (old + new); the other 19 skipped
  });

  it('returns the diff unchanged when Intl.Segmenter is unavailable', () => {
    const input = [del('one two three'), add('one 2 three')];
    expect(addInlineMarks(input, { segmenter: null })).toBe(input);
  });
});

describe('splitByMarks', () => {
  it('returns one unchanged segment without marks', () => {
    expect(splitByMarks('abc', undefined)).toEqual([{ text: 'abc', changed: false }]);
    expect(splitByMarks('abc', [])).toEqual([{ text: 'abc', changed: false }]);
  });

  it('is lossless for edge, adjacent and middle marks', () => {
    const text = 'abcdefgh';
    for (const marks of [
      [[0, 2]],
      [[6, 8]],
      [[0, 8]],
      [
        [1, 3],
        [3, 5],
      ],
      [
        [0, 1],
        [4, 5],
        [7, 8],
      ],
    ] as Range[][]) {
      const parts = splitByMarks(text, marks);
      expect(parts.map((p) => p.text).join('')).toBe(text);
      expect(parts.every((p) => p.text.length > 0)).toBe(true);
    }
    expect(splitByMarks('abcdef', [[2, 4]])).toEqual([
      { text: 'ab', changed: false },
      { text: 'cd', changed: true },
      { text: 'ef', changed: false },
    ]);
  });
});
