import { describe, expect, it } from 'vitest';
import {
  categoryOf,
  isCategoryExcluded,
  CATEGORY_EXTENSIONS,
  DEFAULT_CATEGORY_TOGGLES,
  NATIVE_EXTENSION_LIST,
} from './categories';
import { isMergeableText } from './index-store';

describe('categories', () => {
  it('classifies Obsidian native formats', () => {
    expect(categoryOf('notes/daily.md')).toBe('native');
    expect(categoryOf('a/b.canvas')).toBe('native');
    expect(categoryOf('db/tasks.base')).toBe('native');
  });

  it('classifies media by Obsidian accepted extensions', () => {
    expect(categoryOf('img/photo.JPG')).toBe('image');
    expect(categoryOf('img/pic.avif')).toBe('image');
    expect(categoryOf('voice/memo.m4a')).toBe('audio');
    expect(categoryOf('voice/call.3gp')).toBe('audio');
    expect(categoryOf('media/clip.mp4')).toBe('video');
    expect(categoryOf('media/talk.ogv')).toBe('video');
    // webm is dual-listed by Obsidian (audio + video); we classify video.
    expect(categoryOf('media/clip.webm')).toBe('video');
    expect(categoryOf('docs/paper.pdf')).toBe('pdf');
  });

  it('sends everything Obsidian does not natively support to other', () => {
    // Formats Obsidian's help page does not list.
    expect(categoryOf('img/photo.heic')).toBe('other');
    expect(categoryOf('voice/memo.opus')).toBe('other');
    expect(categoryOf('voice/memo.aac')).toBe('other');
    expect(categoryOf('media/clip.avi')).toBe('other');
    expect(categoryOf('media/clip.m4v')).toBe('other');
    // Text formats still merge (see below) but are excludable as other.
    expect(categoryOf('notes/plain.txt')).toBe('other');
    expect(categoryOf('data/config.json')).toBe('other');
    expect(categoryOf('data/table.csv')).toBe('other');
    expect(categoryOf('slides/deck.pptx')).toBe('other');
    expect(categoryOf('no-extension')).toBe('other');
  });

  it('pins the extension lists to Obsidian’s official file-formats page', () => {
    expect(NATIVE_EXTENSION_LIST).toEqual(['base', 'canvas', 'md']);
    expect(CATEGORY_EXTENSIONS.image).toEqual([
      'avif',
      'bmp',
      'gif',
      'jpeg',
      'jpg',
      'png',
      'svg',
      'webp',
    ]);
    expect(CATEGORY_EXTENSIONS.audio).toEqual(['3gp', 'flac', 'm4a', 'mp3', 'ogg', 'wav']);
    expect(CATEGORY_EXTENSIONS.video).toEqual(['mkv', 'mov', 'mp4', 'ogv', 'webm']);
    expect(CATEGORY_EXTENSIONS.pdf).toEqual(['pdf']);
  });

  it('native formats are never excludable; toggles gate their category only', () => {
    const noVideo = { ...DEFAULT_CATEGORY_TOGGLES, video: false };
    expect(isCategoryExcluded('media/clip.mp4', noVideo)).toBe(true);
    expect(isCategoryExcluded('img/photo.png', noVideo)).toBe(false);
    const nothing = { image: false, audio: false, video: false, pdf: false, other: false };
    expect(isCategoryExcluded('notes/daily.md', nothing)).toBe(false);
    expect(isCategoryExcluded('a/b.canvas', nothing)).toBe(false);
    expect(isCategoryExcluded('db/tasks.base', nothing)).toBe(false);
    expect(isCategoryExcluded('slides/deck.pptx', nothing)).toBe(true);
    // Behavior change vs pre-alignment: txt is excludable via "other".
    expect(isCategoryExcluded('notes/plain.txt', nothing)).toBe(true);
    expect(isCategoryExcluded('notes/plain.txt', DEFAULT_CATEGORY_TOGGLES)).toBe(false);
  });

  it('merge policy is decoupled from category', () => {
    // Excludable as "other", but still diff3-merges while synced.
    expect(categoryOf('n.txt')).toBe('other');
    expect(isMergeableText('n.txt')).toBe(true);
    expect(isMergeableText('c.json')).toBe(true);
    // Bases are YAML: native AND mergeable.
    expect(isMergeableText('b.base')).toBe(true);
    expect(isMergeableText('img/photo.png')).toBe(false);
  });
});
