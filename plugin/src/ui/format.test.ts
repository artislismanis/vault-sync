import { describe, expect, it } from 'vitest';
import { deviceLabel, formatBytes, formatRelativeWhen } from './format';

describe('formatBytes', () => {
  it('picks sensible units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(4 * 1024 + 100)).toBe('4.1 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('formatRelativeWhen', () => {
  const now = new Date('2026-07-12T12:00:00Z');
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();

  it('buckets by age', () => {
    expect(formatRelativeWhen(ago(30), now)).toBe('just now');
    expect(formatRelativeWhen(ago(5 * 60), now)).toBe('5 min ago');
    expect(formatRelativeWhen(ago(3 * 3600), now)).toBe('3 h ago');
    expect(formatRelativeWhen(ago(2 * 86400), now)).toBe('2 d ago');
  });

  it('falls back to a locale date beyond 7 days', () => {
    const old = ago(30 * 86400);
    expect(formatRelativeWhen(old, now)).toBe(new Date(old).toLocaleDateString());
  });
});

describe('deviceLabel', () => {
  const names = new Map([['dev-2', 'phone']]);

  it('labels own, known, and unknown devices', () => {
    expect(deviceLabel('dev-1', 'dev-1', names)).toBe('this device');
    expect(deviceLabel('dev-2', 'dev-1', names)).toBe('phone');
    expect(deviceLabel('dev-3', 'dev-1', names)).toBe('unknown device');
    // Own device wins even when the server has a name for it.
    expect(deviceLabel('dev-2', 'dev-2', names)).toBe('this device');
  });
});
