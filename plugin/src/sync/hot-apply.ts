// Best-effort reconciliation of Obsidian's live state with pulled config, so
// enabled community plugins, CSS snippets, and the active theme take effect
// without the user manually reloading Obsidian. `app.plugins`/`app.customCss`
// are internal, UNDOCUMENTED Obsidian APIs — not in the public obsidian.d.ts
// types, and free to change shape across releases or be absent on mobile.
// Every access is capability-checked and wrapped in try/catch; anything this
// can't reach just falls through to the engine's existing "reload to apply"
// notice (hotkeys, main app settings, and this API surface itself if it ever
// disappears).

export interface InternalPluginManager {
  enabledPlugins?: Set<string>;
  enablePlugin?(id: string): Promise<void>;
  disablePlugin?(id: string): Promise<void>;
}

export interface InternalCustomCss {
  snippets?: string[];
  enabledSnippets?: Set<string>;
  theme?: string;
  readSnippets?(): Promise<void>;
  setCssEnabledStatus?(name: string, enabled: boolean): void;
  setTheme?(name: string): void;
}

export interface InternalApp {
  plugins?: InternalPluginManager;
  customCss?: InternalCustomCss;
}

/** Structural subset of ConfigFs this module needs — keeps it unit-testable. */
export interface ConfigReader {
  stat(canonical: string): Promise<{ mtime: number; size: number } | null>;
  read(canonical: string): Promise<Uint8Array>;
}

export async function hotApplyConfig(app: InternalApp, configFs: ConfigReader): Promise<void> {
  await Promise.allSettled([
    hotApplyPlugins(app, configFs),
    hotApplySnippetsAndTheme(app, configFs),
  ]);
}

async function hotApplyPlugins(app: InternalApp, configFs: ConfigReader): Promise<void> {
  const mgr = app.plugins;
  if (!mgr?.enabledPlugins || !mgr.enablePlugin || !mgr.disablePlugin) return;
  const desired = await readJsonArray(configFs, '.obsidian/community-plugins.json');
  if (!desired) return;
  const desiredSet = new Set(desired);
  const current = mgr.enabledPlugins;
  for (const id of desiredSet) {
    if (!current.has(id)) {
      // Not-installed-locally plugins throw — expected, not an error to surface.
      await mgr.enablePlugin(id).catch(() => undefined);
    }
  }
  for (const id of [...current]) {
    if (!desiredSet.has(id)) {
      await mgr.disablePlugin(id).catch(() => undefined);
    }
  }
}

async function hotApplySnippetsAndTheme(app: InternalApp, configFs: ConfigReader): Promise<void> {
  const css = app.customCss;
  if (!css) return;
  // Picks up snippet files added/removed by the sync itself.
  await css.readSnippets?.().catch(() => undefined);

  const appearance = await readJson(configFs, '.obsidian/appearance.json');
  if (!appearance) return;

  if (Array.isArray(appearance.enabledCssSnippets) && css.setCssEnabledStatus && css.snippets) {
    const desired = new Set<string>(appearance.enabledCssSnippets);
    const current = css.enabledSnippets ?? new Set<string>();
    for (const name of css.snippets) {
      const shouldBeOn = desired.has(name);
      if (current.has(name) !== shouldBeOn) {
        try {
          css.setCssEnabledStatus(name, shouldBeOn);
        } catch {
          // ignore — cosmetic, falls back to the reload notice
        }
      }
    }
  }

  if (
    typeof appearance.cssTheme === 'string' &&
    css.setTheme &&
    appearance.cssTheme !== css.theme
  ) {
    try {
      css.setTheme(appearance.cssTheme);
    } catch {
      // ignore
    }
  }
}

async function readJson(
  configFs: ConfigReader,
  canonical: string,
): Promise<Record<string, unknown> | null> {
  try {
    if (!(await configFs.stat(canonical))) return null;
    const bytes = await configFs.read(canonical);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readJsonArray(configFs: ConfigReader, canonical: string): Promise<string[] | null> {
  try {
    if (!(await configFs.stat(canonical))) return null;
    const bytes = await configFs.read(canonical);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
