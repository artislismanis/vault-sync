import { diffIndices } from 'node-diff3';
import type { DiffLine } from './linediff';

// Character-level highlighting inside changed lines. Post-processes the
// output of `lineDiff` (which stays untouched): pairs each deleted line with
// the added line that replaces it and marks the changed characters in both.
// Pure module — no obsidian imports — so it stays unit-testable.

/** Half-open [start, end) range of UTF-16 offsets into a line's text. */
export type Range = [start: number, end: number];

/** A diff line, optionally carrying the changed ranges of a paired del/add. */
export type InlineLine = DiffLine & { marks?: Range[] };

/**
 * Pairs whose graphemes are less than this similar (Dice coefficient:
 * 2 × shared / (old + new)) show as whole-line changes. Below ~half shared
 * the highlights fragment into confetti that is harder to read than none.
 */
export const MIN_INLINE_SIMILARITY = 0.5;

/**
 * Longer lines (UTF-16 units, either side) skip inner highlighting. Checked
 * on the raw string before any segmentation, so a pathological line costs a
 * length compare.
 */
export const MAX_INLINE_LINE_LENGTH = 2_000;

/**
 * Cap on diff work per `addInlineMarks` call: the sum of
 * (old graphemes × new graphemes) over every pair whose diff runs — including
 * pairs then rejected as too dissimilar — measured after trimming the common
 * prefix and suffix. The LCS is quadratic, and for repetitive text (tables,
 * rules, `abab…`) it costs more than the cell count suggests, so the cap is
 * set from the worst case measured, not the random-text case: 250,000 cells
 * is ≤ ~60 ms on desktop even for adversarial repeated-character pairs (the
 * same shape at 2M cells took ~640 ms), so thousands of pairs inside the
 * 10k-line cap cannot freeze mobile. A pair that does not fit in what is
 * left falls back to whole-line. Because it applies to the trimmed middle, a
 * pair whose lines are mostly different is effectively limited to ~500
 * graphemes a side, while a small edit in a line of up to
 * `MAX_INLINE_LINE_LENGTH` still qualifies.
 */
export const MAX_INLINE_CELLS = 250_000;

type Segmenter = { segment(input: string): Iterable<{ segment: string; index: number }> };

export type InlineOptions = {
  /** Grapheme segmenter; `null` simulates a runtime without `Intl.Segmenter`. */
  segmenter?: Segmenter | null;
  minSimilarity?: number;
  maxLineLength?: number;
  maxCells?: number;
};

let defaultSegmenter: Segmenter | null | undefined;

function getDefaultSegmenter(): Segmenter | null {
  if (defaultSegmenter === undefined) {
    defaultSegmenter =
      typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  }
  return defaultSegmenter;
}

type Grapheme = { key: string; start: number; end: number };

function graphemes(text: string, segmenter: Segmenter): Grapheme[] {
  const out: Grapheme[] = [];
  for (const { segment, index } of segmenter.segment(text)) {
    // NFC key: canonically equivalent text (é vs e + U+0301) compares equal.
    out.push({ key: segment.normalize('NFC'), start: index, end: index + segment.length });
  }
  return out;
}

/**
 * Pairs each run of deleted lines with the added lines that follow it (k-th
 * with k-th; leftovers stay as they are) and attaches `marks` to pairs that
 * are similar enough and small enough. Returns new objects only for marked
 * lines; the input is not mutated. Line-level output is otherwise identical.
 */
export function addInlineMarks(diff: DiffLine[], options: InlineOptions = {}): InlineLine[] {
  const segmenter = options.segmenter === undefined ? getDefaultSegmenter() : options.segmenter;
  if (!segmenter) return diff;

  const minSimilarity = options.minSimilarity ?? MIN_INLINE_SIMILARITY;
  const maxLineLength = options.maxLineLength ?? MAX_INLINE_LINE_LENGTH;
  let cellsLeft = options.maxCells ?? MAX_INLINE_CELLS;

  const out: InlineLine[] = diff.slice();
  let i = 0;
  while (i < diff.length) {
    if (diff[i]!.kind !== 'del') {
      i++;
      continue;
    }
    let delEnd = i;
    while (delEnd < diff.length && diff[delEnd]!.kind === 'del') delEnd++;
    let addEnd = delEnd;
    while (addEnd < diff.length && diff[addEnd]!.kind === 'add') addEnd++;

    const pairs = Math.min(delEnd - i, addEnd - delEnd);
    for (let k = 0; k < pairs; k++) {
      const oldText = diff[i + k]!.text;
      const newText = diff[delEnd + k]!.text;
      if (cellsLeft <= 0) break; // budget spent: skip segmenting the rest
      if (oldText.length > maxLineLength || newText.length > maxLineLength) continue;

      const result = markPair(oldText, newText, segmenter, minSimilarity, cellsLeft);
      if (!result) continue; // over budget: no diff ran, nothing to charge
      // Charge every diff that ran, including pairs rejected as too dissimilar:
      // they cost the same time, and a heavily rewritten file is mostly those.
      cellsLeft -= result.cells;
      if (result.old.length > 0) out[i + k] = { ...diff[i + k]!, marks: result.old };
      if (result.new.length > 0) out[delEnd + k] = { ...diff[delEnd + k]!, marks: result.new };
    }
    i = addEnd;
  }
  return out;
}

function markPair(
  oldText: string,
  newText: string,
  segmenter: Segmenter,
  minSimilarity: number,
  cellsLeft: number,
): { old: Range[]; new: Range[]; cells: number } | null {
  // Returns null only when the pair does not fit the budget (no diff ran).
  // A pair rejected as too dissimilar returns empty marks with its cells.
  const a = graphemes(oldText, segmenter);
  const b = graphemes(newText, segmenter);

  let prefix = 0;
  const shortest = Math.min(a.length, b.length);
  while (prefix < shortest && a[prefix]!.key === b[prefix]!.key) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    a[a.length - 1 - suffix]!.key === b[b.length - 1 - suffix]!.key
  ) {
    suffix++;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const cells = midA.length * midB.length;
  if (cells > cellsLeft) return null;

  const oldMarks: Range[] = [];
  const newMarks: Range[] = [];
  let changedOld = 0;
  let changedNew = 0;
  if (midA.length > 0 || midB.length > 0) {
    const chunks = diffIndices(
      midA.map((g) => g.key),
      midB.map((g) => g.key),
    );
    for (const chunk of chunks) {
      const [aStart, aLen] = chunk.buffer1;
      const [bStart, bLen] = chunk.buffer2;
      changedOld += aLen;
      changedNew += bLen;
      pushRange(oldMarks, midA, aStart, aLen);
      pushRange(newMarks, midB, bStart, bLen);
    }
  }
  if (changedOld === 0 && changedNew === 0) return { old: [], new: [], cells };

  const shared = a.length - changedOld; // == b.length - changedNew
  const similarity = (2 * shared) / (a.length + b.length);
  if (similarity < minSimilarity) return { old: [], new: [], cells };
  return { old: oldMarks, new: newMarks, cells };
}

function pushRange(ranges: Range[], graphemes: Grapheme[], start: number, length: number): void {
  if (length === 0) return;
  ranges.push([graphemes[start]!.start, graphemes[start + length - 1]!.end]);
}

/**
 * Splits `text` into contiguous segments at the mark boundaries. Joining the
 * segments reproduces `text`; with no marks the result is a single unchanged
 * segment.
 */
export function splitByMarks(
  text: string,
  marks: Range[] | undefined,
): { text: string; changed: boolean }[] {
  if (!marks || marks.length === 0) return [{ text, changed: false }];
  const out: { text: string; changed: boolean }[] = [];
  let pos = 0;
  for (const [start, end] of marks) {
    if (start > pos) out.push({ text: text.slice(pos, start), changed: false });
    if (end > start) out.push({ text: text.slice(start, end), changed: true });
    pos = Math.max(pos, end);
  }
  if (pos < text.length) out.push({ text: text.slice(pos), changed: false });
  return out;
}
