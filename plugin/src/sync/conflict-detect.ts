// Conflict-sibling discovery. Pure pattern-matching over already-materialized
// filenames (engine.ts's conflictPathFor: '<stem> (conflict <date> <device>
// [ <n>])<ext>') — independent of how the engine split stem/ext when it
// created them. Local path domain only; nothing here calls into SyncEngine.

const CONFLICT_SUFFIX = / \(conflict [^)]*\)((?:\.[^./]*)?)$/;

/** The original path a conflict-sibling path resolves to, or null. */
export function originalPathFor(path: string): string | null {
  const slash = path.lastIndexOf('/');
  const dir = slash === -1 ? '' : path.slice(0, slash + 1);
  const base = slash === -1 ? path : path.slice(slash + 1);
  const match = base.match(CONFLICT_SUFFIX);
  if (!match) return null;
  const stem = base.slice(0, match.index);
  return `${dir}${stem}${match[1] ?? ''}`;
}

export interface ConflictGroup {
  original: string;
  siblings: string[];
}

/**
 * Groups conflict siblings by original path, scoped to whatever `paths`
 * contains (whole vault, or one folder). A sibling only counts if its
 * original is also present in `paths`.
 */
export function findConflictGroups(paths: string[]): ConflictGroup[] {
  const pathSet = new Set(paths);
  const bySibling = new Map<string, string[]>();
  for (const path of paths) {
    const original = originalPathFor(path);
    if (original === null || !pathSet.has(original)) continue;
    const list = bySibling.get(original);
    if (list) list.push(path);
    else bySibling.set(original, [path]);
  }
  return [...bySibling.entries()].map(([original, siblings]) => ({ original, siblings }));
}
