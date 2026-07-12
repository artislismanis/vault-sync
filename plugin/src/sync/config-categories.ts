import type { Revision } from '@vault-sync/shared';

// `.obsidian` settings sync: classification and policy (docs/decisions.md).
// Wire paths always use the canonical '.obsidian/' prefix regardless of the
// local configDir name — ConfigFs maps canonical ↔ local. Pure module.

export const CONFIG_WIRE_PREFIX = '.obsidian/';

export function isConfigPath(path: string): boolean {
  return path.startsWith(CONFIG_WIRE_PREFIX);
}

// Category granularity mirrors Obsidian Sync's vault-configuration options
// (obsidian.md/help/sync/settings), with plugin settings split from plugin
// code so mobile can take settings without executing synced code.
export type ConfigCategory =
  | 'never'
  | 'mainSettings' // app.json
  | 'appearance' // appearance.json
  | 'themesSnippets' // themes/**, snippets/**
  | 'hotkeys' // hotkeys.json
  | 'corePluginList' // core-plugins.json
  | 'corePluginSettings' // remaining top-level config (default bucket)
  | 'communityPluginList' // community-plugins.json
  | 'communityPluginSettings' // plugins/<id>/data.json
  | 'communityPlugins'; // plugins/** code and assets

export type ConfigSyncToggles = Record<Exclude<ConfigCategory, 'never'>, boolean>;

export const DEFAULT_CONFIG_SYNC_TOGGLES: ConfigSyncToggles = {
  mainSettings: true,
  appearance: true,
  themesSnippets: true,
  hotkeys: true,
  corePluginList: true,
  corePluginSettings: true,
  communityPluginList: true,
  communityPluginSettings: true,
  communityPlugins: true,
};

/**
 * First match wins. `ownPluginCanonicalDir` is this plugin's own directory in
 * canonical form (e.g. '.obsidian/plugins/vault-sync') — 'never': its
 * data.json holds the bearer token and the UNWRAPPED VMK, and the sync
 * index/spool live there (feedback loops). Computed from manifest.dir at
 * runtime, never hardcoded.
 */
export function configCategoryOf(
  canonicalPath: string,
  ownPluginCanonicalDir: string,
): ConfigCategory {
  if (!isConfigPath(canonicalPath)) return 'never';
  if (
    canonicalPath === ownPluginCanonicalDir ||
    canonicalPath.startsWith(`${ownPluginCanonicalDir}/`)
  ) {
    return 'never';
  }
  const rest = canonicalPath.slice(CONFIG_WIRE_PREFIX.length);
  const basename = rest.split('/').pop() ?? '';
  // Per-device window/pane state; churns constantly. Top-level only —
  // a plugin file that happens to start with "workspace" still syncs.
  if (!rest.includes('/') && basename.startsWith('workspace')) return 'never';
  if (basename.endsWith('.tmp') || basename.endsWith('.bak') || basename === '.DS_Store') {
    return 'never';
  }
  if (rest === 'app.json') return 'mainSettings';
  if (rest === 'appearance.json') return 'appearance';
  if (rest.startsWith('themes/') || rest.startsWith('snippets/')) return 'themesSnippets';
  if (rest === 'hotkeys.json') return 'hotkeys';
  if (rest === 'core-plugins.json') return 'corePluginList';
  if (rest === 'community-plugins.json') return 'communityPluginList';
  if (rest.startsWith('plugins/')) {
    return basename === 'data.json' && rest.split('/').length === 3
      ? 'communityPluginSettings'
      : 'communityPlugins';
  }
  // Default bucket: graph.json, daily-notes.json, icons/, and whatever
  // future Obsidian versions add — unknown files sync under a toggle.
  return 'corePluginSettings';
}

export function isConfigExcluded(
  canonicalPath: string,
  enabled: boolean,
  toggles: ConfigSyncToggles,
  ownPluginCanonicalDir: string,
): boolean {
  const category = configCategoryOf(canonicalPath, ownPluginCanonicalDir);
  if (category === 'never') return true;
  if (!enabled) return true;
  return !toggles[category];
}

/**
 * Last-writer-wins pick for config conflicts: newest clientMtime, ties broken
 * by lexicographically greatest revision id so every device converges on the
 * same winner. The losers stay in history (docs/decisions.md — LWW amends
 * hard rule 4's conflict-file letter for config paths only).
 */
export function pickLwwHead(heads: Revision[]): Revision {
  return heads.reduce((best, head) => {
    const bestTime = Date.parse(best.clientMtime);
    const headTime = Date.parse(head.clientMtime);
    if (headTime > bestTime) return head;
    if (headTime === bestTime && head.id > best.id) return head;
    return best;
  });
}
