import { describe, expect, it } from 'vitest';
import type { Revision } from '@vault-sync/shared';
import {
  configCategoryOf,
  ConfigCategory,
  DEFAULT_CONFIG_SYNC_TOGGLES,
  isConfigExcluded,
  isConfigPath,
  pickLwwHead,
} from './config-categories';

const OWN = '.obsidian/plugins/vault-sync';

describe('configCategoryOf', () => {
  const cases: [string, ConfigCategory][] = [
    // Own plugin dir: secrets + sync state, never synced.
    ['.obsidian/plugins/vault-sync/data.json', 'never'],
    ['.obsidian/plugins/vault-sync/sync-index-abc.json', 'never'],
    ['.obsidian/plugins/vault-sync/spool/rev/00000', 'never'],
    // Per-device state and junk.
    ['.obsidian/workspace.json', 'never'],
    ['.obsidian/workspace-mobile.json', 'never'],
    ['.obsidian/app.json.tmp', 'never'],
    ['.obsidian/plugins/foo/data.json.bak', 'never'],
    ['.obsidian/themes/.DS_Store', 'never'],
    // Obsidian Sync's vault-configuration granularity.
    ['.obsidian/app.json', 'mainSettings'],
    ['.obsidian/appearance.json', 'appearance'],
    ['.obsidian/themes/Minimal/theme.css', 'themesSnippets'],
    ['.obsidian/snippets/custom.css', 'themesSnippets'],
    ['.obsidian/hotkeys.json', 'hotkeys'],
    ['.obsidian/core-plugins.json', 'corePluginList'],
    ['.obsidian/community-plugins.json', 'communityPluginList'],
    // Community plugin settings vs code.
    ['.obsidian/plugins/dataview/data.json', 'communityPluginSettings'],
    ['.obsidian/plugins/dataview/main.js', 'communityPlugins'],
    ['.obsidian/plugins/dataview/manifest.json', 'communityPlugins'],
    ['.obsidian/plugins/dataview/styles.css', 'communityPlugins'],
    // Nested data.json inside a plugin subdir is code/assets, not settings.
    ['.obsidian/plugins/foo/assets/data.json', 'communityPlugins'],
    // Default bucket: remaining core config + unknown future files.
    ['.obsidian/graph.json', 'corePluginSettings'],
    ['.obsidian/daily-notes.json', 'corePluginSettings'],
    ['.obsidian/some-future-file.json', 'corePluginSettings'],
    ['.obsidian/icons/lucide.json', 'corePluginSettings'],
    // A plugin file merely NAMED workspace* is not per-device state.
    ['.obsidian/plugins/foo/workspace-helper.js', 'communityPlugins'],
  ];

  it.each(cases)('%s → %s', (path, expected) => {
    expect(configCategoryOf(path, OWN)).toBe(expected);
  });

  it('respects a non-default plugin id for the own-plugin rule', () => {
    const own = '.obsidian/plugins/my-fork';
    expect(configCategoryOf('.obsidian/plugins/my-fork/data.json', own)).toBe('never');
    expect(configCategoryOf('.obsidian/plugins/vault-sync/data.json', own)).toBe(
      'communityPluginSettings',
    );
    // Prefix match must be segment-aware: my-fork-2 is a different plugin.
    expect(configCategoryOf('.obsidian/plugins/my-fork-2/data.json', own)).toBe(
      'communityPluginSettings',
    );
  });

  it('non-config paths are never', () => {
    expect(configCategoryOf('notes/todo.md', OWN)).toBe('never');
    expect(isConfigPath('notes/todo.md')).toBe(false);
    expect(isConfigPath('.obsidian/app.json')).toBe(true);
  });
});

describe('isConfigExcluded', () => {
  const all = { ...DEFAULT_CONFIG_SYNC_TOGGLES };

  it('master off excludes everything', () => {
    expect(isConfigExcluded('.obsidian/app.json', false, all, OWN)).toBe(true);
    expect(isConfigExcluded('.obsidian/hotkeys.json', false, all, OWN)).toBe(true);
  });

  it('never-category is excluded even with master on and all toggles on', () => {
    expect(isConfigExcluded('.obsidian/workspace.json', true, all, OWN)).toBe(true);
    expect(isConfigExcluded('.obsidian/plugins/vault-sync/data.json', true, all, OWN)).toBe(true);
  });

  it('category toggles exclude their files only', () => {
    const toggles = { ...all, communityPlugins: false };
    expect(isConfigExcluded('.obsidian/plugins/foo/main.js', true, toggles, OWN)).toBe(true);
    expect(isConfigExcluded('.obsidian/plugins/foo/data.json', true, toggles, OWN)).toBe(false);
    expect(isConfigExcluded('.obsidian/appearance.json', true, toggles, OWN)).toBe(false);
  });

  it('main settings and core plugin settings gate independently', () => {
    const toggles = { ...all, mainSettings: false };
    expect(isConfigExcluded('.obsidian/app.json', true, toggles, OWN)).toBe(true);
    expect(isConfigExcluded('.obsidian/graph.json', true, toggles, OWN)).toBe(false);
    const noCoreList = { ...all, corePluginList: false };
    expect(isConfigExcluded('.obsidian/core-plugins.json', true, noCoreList, OWN)).toBe(true);
    expect(isConfigExcluded('.obsidian/daily-notes.json', true, noCoreList, OWN)).toBe(false);
  });
});

describe('pickLwwHead', () => {
  const head = (id: string, clientMtime: string) => ({ id, clientMtime }) as unknown as Revision;

  it('picks the newest clientMtime', () => {
    const winner = pickLwwHead([
      head('aaa', '2026-07-12T10:00:00.000Z'),
      head('bbb', '2026-07-12T11:00:00.000Z'),
      head('ccc', '2026-07-12T09:00:00.000Z'),
    ]);
    expect(winner.id).toBe('bbb');
  });

  it('breaks ties by greatest revision id (deterministic across devices)', () => {
    const t = '2026-07-12T10:00:00.000Z';
    expect(pickLwwHead([head('aaa', t), head('zzz', t), head('mmm', t)]).id).toBe('zzz');
    // Order-independence.
    expect(pickLwwHead([head('zzz', t), head('aaa', t)]).id).toBe('zzz');
  });
});
