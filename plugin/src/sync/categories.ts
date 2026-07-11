import { isMergeableText } from './index-store';

// Selective-sync categories (parity with Obsidian Sync's type toggles).
// Notes/text are NEVER excludable — category filtering applies only to
// attachments.

export type FileCategory = 'note' | 'image' | 'audio' | 'video' | 'pdf' | 'other';
export type ExcludableCategory = Exclude<FileCategory, 'note'>;

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'heif']);
const AUDIO = new Set(['mp3', 'wav', 'm4a', 'ogg', 'oga', 'flac', 'aac', '3gp', 'opus']);
const VIDEO = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v']);

/** Extension lists per toggleable category, for settings UI copy. */
export const CATEGORY_EXTENSIONS: Record<'image' | 'audio' | 'video' | 'pdf', readonly string[]> = {
  image: [...IMAGE].sort(),
  audio: [...AUDIO].sort(),
  video: [...VIDEO].sort(),
  pdf: ['pdf'],
};

export function categoryOf(path: string): FileCategory {
  if (isMergeableText(path)) return 'note';
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
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
  return category === 'note' ? false : !toggles[category];
}
