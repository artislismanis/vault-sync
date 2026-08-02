import { describe, expect, it } from 'vitest';
import { hotApplyConfig, InternalApp, ConfigReader } from './hot-apply';

function fakeConfigFs(files: Record<string, unknown>): ConfigReader {
  const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  return {
    stat: async (p) => (p in files ? { mtime: 0, size: 0 } : null),
    read: async (p) => encode(files[p]),
  };
}

describe('hotApplyConfig', () => {
  it('enables and disables plugins to match community-plugins.json', async () => {
    const configFs = fakeConfigFs({
      '.obsidian/community-plugins.json': ['keep', 'add-me'],
    });
    const enabled: string[] = [];
    const disabled: string[] = [];
    const app: InternalApp = {
      plugins: {
        enabledPlugins: new Set(['keep', 'remove-me']),
        enablePlugin: async (id) => void enabled.push(id),
        disablePlugin: async (id) => void disabled.push(id),
      },
    };
    await hotApplyConfig(app, configFs);
    expect(enabled).toEqual(['add-me']);
    expect(disabled).toEqual(['remove-me']);
  });

  it('does nothing to plugins when the internal API is unavailable', async () => {
    const configFs = fakeConfigFs({ '.obsidian/community-plugins.json': ['x'] });
    // No throw, no-op — the reload notice remains the fallback.
    await expect(hotApplyConfig({}, configFs)).resolves.toBeUndefined();
  });

  it('reconciles snippet enabled state and theme from appearance.json', async () => {
    const configFs = fakeConfigFs({
      '.obsidian/appearance.json': { enabledCssSnippets: ['on.css'], cssTheme: 'Nord' },
    });
    const setStatus: [string, boolean][] = [];
    let theme = 'Default';
    const app: InternalApp = {
      customCss: {
        snippets: ['on.css', 'off.css'],
        enabledSnippets: new Set(['off.css']),
        theme: 'Default',
        readSnippets: async () => {},
        setCssEnabledStatus: (name, enabled) => void setStatus.push([name, enabled]),
        setTheme: (name) => void (theme = name),
      },
    };
    await hotApplyConfig(app, configFs);
    expect(setStatus).toEqual(
      expect.arrayContaining([
        ['on.css', true],
        ['off.css', false],
      ]),
    );
    expect(theme).toBe('Nord');
  });

  it('leaves theme/snippets untouched when appearance.json is missing', async () => {
    const configFs = fakeConfigFs({});
    let called = false;
    const app: InternalApp = {
      customCss: {
        snippets: ['a.css'],
        enabledSnippets: new Set(),
        readSnippets: async () => {},
        setCssEnabledStatus: () => void (called = true),
      },
    };
    await hotApplyConfig(app, configFs);
    expect(called).toBe(false);
  });
});
