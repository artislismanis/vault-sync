// Selective-sync categories, aligned exactly with Obsidian's official format
// support (obsidian.md/help/file-formats). Native formats are NEVER
// excludable; the media categories use Obsidian's accepted-extension lists
// verbatim; everything else — including text formats like txt/json/csv that
// still diff3-merge (see index-store.ts) — is 'other'. Category (what syncs)
// and merge policy (how conflicts resolve) are independent axes.

export type FileCategory = 'native' | 'image' | 'audio' | 'video' | 'pdf' | 'other';
export type ExcludableCategory = Exclude<FileCategory, 'native'>;

// Obsidian's native trio: Markdown, JSON Canvas, Bases.
const NATIVE = new Set(['md', 'canvas', 'base']);

const IMAGE = new Set(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const AUDIO = new Set(['flac', 'm4a', 'mp3', 'ogg', 'wav', '3gp']);
// Obsidian lists webm under both audio and video; the container is classified
// video here, so the Video toggle governs webm files.
const VIDEO = new Set(['mkv', 'mov', 'mp4', 'ogv', 'webm']);

export const NATIVE_EXTENSION_LIST: readonly string[] = [...NATIVE].sort();

/** Extension lists per toggleable category, for settings UI copy. */
export const CATEGORY_EXTENSIONS: Record<'image' | 'audio' | 'video' | 'pdf', readonly string[]> = {
  image: [...IMAGE].sort(),
  audio: [...AUDIO].sort(),
  video: [...VIDEO].sort(),
  pdf: ['pdf'],
};

export function categoryOf(path: string): FileCategory {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (NATIVE.has(ext)) return 'native';
  if (IMAGE.has(ext)) return 'image';
  if (AUDIO.has(ext)) return 'audio';
  if (VIDEO.has(ext)) return 'video';
  if (ext === 'pdf') return 'pdf';
  return 'other';
}

export interface CategoryToggles {
  image: boolean;
  audio: boolean;
  video: boolean;
  pdf: boolean;
  other: boolean;
}

export const DEFAULT_CATEGORY_TOGGLES: CategoryToggles = {
  image: true,
  audio: true,
  video: true,
  pdf: true,
  other: true,
};

export function isCategoryExcluded(path: string, toggles: CategoryToggles): boolean {
  const category = categoryOf(path);
  return category === 'native' ? false : !toggles[category];
}
