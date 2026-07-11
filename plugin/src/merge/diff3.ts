import { diff3Merge } from 'node-diff3';

// Three-way merge for text (docs/decisions.md: node-diff3, line granularity).
// Wrapped so the library is swappable. Callers NEVER discard a side on
// conflict — the conflict-file path handles that (hard rule 4).

export type MergeResult = { ok: true; merged: string } | { ok: false };

export function threeWayMerge(base: string, local: string, remote: string): MergeResult {
  const regions = diff3Merge(splitLines(local), splitLines(base), splitLines(remote), {
    excludeFalseConflicts: true,
    stringSeparator: '\n',
  });

  const merged: string[] = [];
  for (const region of regions) {
    if (region.ok) {
      merged.push(...region.ok);
    } else {
      return { ok: false };
    }
  }
  return { ok: true, merged: merged.join('\n') };
}

function splitLines(text: string): string[] {
  return text.split('\n');
}
