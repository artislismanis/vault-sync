// Mount-path mapping for folder connections: a shared vault's content lives
// at wire paths relative to the mount (e.g. 'notes/x.md'), while the local
// vault sees it under a prefix (e.g. 'Reference/notes/x.md'). Pure module.

/**
 * Normalize user input to a canonical mount path: NFC, forward slashes, no
 * edge or duplicate slashes. Returns null for invalid input: empty (vault
 * root would duplicate the main sync) or any dot-leading segment (covers
 * '.obsidian', '.trash', and path traversal).
 */
export function normalizeMountPath(input: string): string | null {
  const cleaned = input
    .trim()
    .normalize('NFC')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '');
  if (!cleaned) return null;
  const segments = cleaned.split('/');
  if (segments.some((segment) => segment === '' || segment.startsWith('.'))) return null;
  return cleaned;
}

/**
 * Error message, or null if the (already normalized) candidate is acceptable
 * alongside the existing mounts. Overlap in either direction is rejected: two
 * connections must never own the same file.
 */
export function validateMountPath(candidate: string, existingMountPaths: string[]): string | null {
  for (const other of existingMountPaths) {
    if (
      candidate === other ||
      candidate.startsWith(`${other}/`) ||
      other.startsWith(`${candidate}/`)
    ) {
      return `overlaps the existing folder connection at "${other}"`;
    }
  }
  return null;
}

/** Local → engine-domain path; null when the path is outside the mount. */
export function stripMount(mountPath: string, localPath: string): string | null {
  return localPath.startsWith(`${mountPath}/`) ? localPath.slice(mountPath.length + 1) : null;
}

/** Engine-domain → local path. */
export function joinMount(mountPath: string, enginePath: string): string {
  return `${mountPath}/${enginePath}`;
}

/** True for the mount root itself and anything under it. */
export function isUnderAnyMount(path: string, mountPaths: string[]): boolean {
  return mountPaths.some((mount) => path === mount || path.startsWith(`${mount}/`));
}
