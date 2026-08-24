// Path identity for collision detection only. shared/src/crypto/path-hmac.ts
// already normalizes internally when hashing, so two NFC/NFD spellings of
// "the same" path already collide server-side today (D3) — this module lets
// the engine detect that before it happens, rather than fix the hashing.
//
// Detection only: never used to build a path fed to scope.stat/read/write.
// Obsidian's file map can be keyed by the raw (non-normalized) spelling, so
// normalizing a path before an I/O call can make a real file unreadable.

export function canonicalKey(path: string): string {
  return path.normalize('NFC').replace(/\\/g, '/');
}

export interface PathCollision {
  canonicalKey: string;
  paths: string[];
}

/** Distinct paths that normalize to the same canonicalKey. */
export function findCanonicalPathCollisions(paths: string[]): PathCollision[] {
  const byKey = new Map<string, Set<string>>();
  for (const path of paths) {
    const key = canonicalKey(path);
    const set = byKey.get(key);
    if (set) set.add(path);
    else byKey.set(key, new Set([path]));
  }
  return [...byKey.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([key, set]) => ({ canonicalKey: key, paths: [...set] }));
}
