import { describe, expect, it } from 'vitest';
import { categoryOf, isCategoryExcluded, DEFAULT_CATEGORY_TOGGLES } from './categories';

describe('categories', () => {
  it('classifies files', () => {
    expect(categoryOf('notes/daily.md')).toBe('note');
    expect(categoryOf('a/b.canvas')).toBe('note');
    expect(categoryOf('img/photo.JPG')).toBe('image');
    expect(categoryOf('voice/memo.m4a')).toBe('audio');
    expect(categoryOf('media/clip.mp4')).toBe('video');
    expect(categoryOf('docs/paper.pdf')).toBe('pdf');
    expect(categoryOf('slides/deck.pptx')).toBe('other');
    expect(categoryOf('no-extension')).toBe('other');
  });

  it('notes are never excludable; toggles gate their category only', () => {
    const noVideo = { ...DEFAULT_CATEGORY_TOGGLES, video: false };
    expect(isCategoryExcluded('media/clip.mp4', noVideo)).toBe(true);
    expect(isCategoryExcluded('img/photo.png', noVideo)).toBe(false);
    const nothing = {
      image: false,
      audio: false,
      video: false,
      pdf: false,
      other: false,
    };
    expect(isCategoryExcluded('notes/daily.md', nothing)).toBe(false);
    expect(isCategoryExcluded('slides/deck.pptx', nothing)).toBe(true);
  });
});
