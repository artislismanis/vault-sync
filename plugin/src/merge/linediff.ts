import { diffComm } from 'node-diff3';

// Two-way line diff for the version-history preview, built on the same
// node-diff3 LCS the merge path uses. Pure module — no obsidian imports —
// so it stays unit-testable.

export type DiffLine = { kind: 'ctx' | 'add' | 'del' | 'gap'; text: string };

// LCS is O(n·m) in lines; beyond this the UI shows preview-only.
export const DIFF_MAX_LINES = 10_000;

export function isDiffable(a: string, b: string, maxLines = DIFF_MAX_LINES): boolean {
  return countLines(a) <= maxLines && countLines(b) <= maxLines;
}

/**
 * Unified diff: deletions then additions per changed hunk, `context` lines of
 * surrounding text, elided stretches collapsed to a single 'gap' line.
 * Identical inputs produce a single gap (callers show "no differences").
 */
export function lineDiff(oldText: string, newText: string, context = 3): DiffLine[] {
  const hunks = diffComm(oldText.split('\n'), newText.split('\n'));
  const out: DiffLine[] = [];

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i]!;
    if (hunk.common) {
      const lines = hunk.common;
      const first = i === 0;
      const last = i === hunks.length - 1;
      // Keep `context` lines adjacent to each neighboring change; collapse
      // the middle. Leading/trailing common runs only border one change.
      const keepHead = first ? 0 : context;
      const keepTail = last ? 0 : context;
      if (lines.length <= keepHead + keepTail + 1) {
        for (const text of lines) out.push({ kind: 'ctx', text });
      } else {
        for (const text of lines.slice(0, keepHead)) out.push({ kind: 'ctx', text });
        out.push({ kind: 'gap', text: `⋯ ${lines.length - keepHead - keepTail} unchanged lines` });
        for (const text of lines.slice(lines.length - keepTail)) out.push({ kind: 'ctx', text });
      }
    } else {
      for (const text of hunk.buffer1) out.push({ kind: 'del', text });
      for (const text of hunk.buffer2) out.push({ kind: 'add', text });
    }
  }
  return out;
}

export function hasChanges(diff: DiffLine[]): boolean {
  return diff.some((line) => line.kind === 'add' || line.kind === 'del');
}

function countLines(text: string): number {
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}
