import type { IndexEntry } from './index-store';

// Pure reconciliation planner — the correctness core of the sync engine.
// Compares three views of the vault (local scan, sync index, remote heads,
// with paths already decrypted by the caller) and emits actions. No I/O, so
// every case is unit-testable.
//
// Change detection is mtime+size vs the index (docs/explanation/sync-protocol.md);
// external edits are caught because the scan covers the whole vault folder,
// not just Obsidian events.

export interface LocalFile {
  path: string;
  mtime: number;
  size: number;
}

export interface RemoteHead {
  revisionId: string;
  deleted: boolean;
  sizeBytes: number;
}

export interface RemoteItem {
  path: string;
  heads: RemoteHead[];
}

export type Action =
  | { kind: 'push'; path: string; parentIds: string[] }
  | { kind: 'pushDelete'; path: string; parentIds: string[] }
  | { kind: 'pull'; path: string; revisionId: string }
  | { kind: 'deleteLocal'; path: string; tombstoneId: string }
  | { kind: 'merge'; path: string; remoteRevisionId: string }
  | { kind: 'mergeHeads'; path: string; headIds: string[] }
  | { kind: 'exclude'; path: string; reason: 'size' | 'category' | 'scope' } // stop syncing, never a delete
  | { kind: 'forgetIndex'; path: string };

export interface PlanInput {
  local: LocalFile[];
  index: IndexEntry[];
  remote: RemoteItem[];
  /** Selective-sync size cap in bytes; 0 or absent = unlimited. */
  maxFileSizeBytes?: number;
  /** Selective-sync category filter; absent = everything syncs. */
  isCategoryExcluded?: (path: string) => boolean;
  /**
   * Structural scope filter (paths owned by another connection / config paths
   * inside a mount); same stop-updating semantics, logged silently.
   */
  isScopeExcluded?: (path: string) => boolean;
}

export function planSync(input: PlanInput): Action[] {
  const localByPath = new Map(input.local.map((f) => [f.path, f]));
  const indexByPath = new Map(input.index.map((e) => [e.path, e]));
  const remoteByPath = new Map(input.remote.map((r) => [r.path, r]));
  const cap = input.maxFileSizeBytes ?? 0;

  const paths = new Set<string>([
    ...localByPath.keys(),
    ...indexByPath.keys(),
    ...remoteByPath.keys(),
  ]);

  const actions: Action[] = [];
  for (const path of [...paths].sort()) {
    const local = localByPath.get(path);
    const idx = indexByPath.get(path);
    const heads = remoteByPath.get(path)?.heads ?? [];

    const overCap =
      cap > 0 &&
      ((local !== undefined && local.size > cap) ||
        heads.some((h) => !h.deleted && h.sizeBytes > cap));
    const scopeExcluded = input.isScopeExcluded?.(path) ?? false;
    const categoryExcluded = input.isCategoryExcluded?.(path) ?? false;
    const excludedByPolicy = overCap || scopeExcluded || categoryExcluded;

    if (idx?.excluded) {
      // Selective sync: divergence is expected while excluded. Re-inclusion
      // (cap raised / category re-enabled / mount disconnected) drops the
      // entry so the file rejoins through the normal new-file/merge/conflict
      // path next pass.
      if (!excludedByPolicy) actions.push({ kind: 'forgetIndex', path });
      continue;
    }
    if (excludedByPolicy) {
      actions.push({
        kind: 'exclude',
        path,
        reason: overCap ? 'size' : scopeExcluded ? 'scope' : 'category',
      });
      continue;
    }

    // Concurrent remote heads: merge them first; local edits (if any) are
    // reconciled on the follow-up pass once a single head exists.
    if (heads.length > 1) {
      actions.push({ kind: 'mergeHeads', path, headIds: heads.map((h) => h.revisionId) });
      continue;
    }
    const head = heads[0];
    const localChanged =
      local !== undefined && (!idx || local.mtime !== idx.mtime || local.size !== idx.size);

    if (!head) {
      // Nothing on the server for this path.
      if (local) {
        actions.push({ kind: 'push', path, parentIds: [] });
      } else if (idx) {
        actions.push({ kind: 'forgetIndex', path });
      }
      continue;
    }

    const remoteAdvanced = head.revisionId !== idx?.lastSyncedRevisionId;

    if (!remoteAdvanced) {
      // Server is exactly where we left it; only local state matters.
      if (local && localChanged) {
        actions.push({ kind: 'push', path, parentIds: [head.revisionId] });
      } else if (!local && !head.deleted) {
        actions.push({ kind: 'pushDelete', path, parentIds: [head.revisionId] });
      } else if (!local && head.deleted) {
        actions.push({ kind: 'forgetIndex', path });
      }
      continue;
    }

    // Remote advanced past our last sync.
    if (head.deleted) {
      if (local && localChanged) {
        // Edit-vs-delete: the edit wins; push resurrects the file.
        actions.push({ kind: 'push', path, parentIds: [head.revisionId] });
      } else if (local) {
        actions.push({ kind: 'deleteLocal', path, tombstoneId: head.revisionId });
      } else if (idx) {
        actions.push({ kind: 'forgetIndex', path });
      }
      continue;
    }

    if (!local) {
      // Delete-vs-edit resolves to the edit; fresh devices also land here.
      actions.push({ kind: 'pull', path, revisionId: head.revisionId });
    } else if (!localChanged) {
      actions.push({ kind: 'pull', path, revisionId: head.revisionId });
    } else {
      actions.push({ kind: 'merge', path, remoteRevisionId: head.revisionId });
    }
  }
  return actions;
}

// Safety brake: refuses a mass-destructive pass rather than executing it —
// most likely caused by a bad scan (docs/roadmap.md Tier 1), not real intent.
// Two independent directions: pushDelete tombstones server items (checked
// against the known index size), pull-over-an-existing-file and deleteLocal
// destroy local content (checked against the current local file count).
// Blocked actions are simply dropped: no index advancement, replanned next
// pass. Threshold: docs/decisions.md.
const SAFETY_BRAKE_MIN_COUNT = 20;
const SAFETY_BRAKE_MIN_RATIO = 0.25;

function tripsBrake(count: number, total: number): boolean {
  return count > SAFETY_BRAKE_MIN_COUNT && total > 0 && count / total > SAFETY_BRAKE_MIN_RATIO;
}

export interface SafetyBrakeResult {
  actions: Action[];
  blocked: Action[];
  triggered: boolean;
}

export function applySafetyBrake(
  actions: Action[],
  localPaths: ReadonlySet<string>,
  indexCount: number,
): SafetyBrakeResult {
  const pushDeletes = actions.filter((a) => a.kind === 'pushDelete');
  const localDestructive = actions.filter(
    (a) => a.kind === 'deleteLocal' || (a.kind === 'pull' && localPaths.has(a.path)),
  );

  const remoteBrake = tripsBrake(pushDeletes.length, indexCount);
  const localBrake = tripsBrake(localDestructive.length, localPaths.size);
  if (!remoteBrake && !localBrake) return { actions, blocked: [], triggered: false };

  const blocked = new Set<Action>([
    ...(remoteBrake ? pushDeletes : []),
    ...(localBrake ? localDestructive : []),
  ]);
  return {
    actions: actions.filter((a) => !blocked.has(a)),
    blocked: [...blocked],
    triggered: true,
  };
}
