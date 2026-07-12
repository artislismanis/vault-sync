import { App, Notice, Platform, PluginSettingTab, Setting } from 'obsidian';
import {
  createEnvelope,
  decryptVaultName,
  deriveVaultKeys,
  encryptVaultName,
  generateVmk,
  getSodium,
  rewrapVmk,
  unwrapVmk,
  VaultKind,
  VaultSummary,
  WrongPassphraseError,
} from '@vault-sync/shared';
import type VaultSyncPlugin from './main';
import { RestClient } from './transport/rest';
import {
  CATEGORY_EXTENSIONS,
  CategoryToggles,
  DEFAULT_CATEGORY_TOGGLES,
  NATIVE_EXTENSION_LIST,
} from './sync/categories';
import { ConfigSyncToggles, DEFAULT_CONFIG_SYNC_TOGGLES } from './sync/config-categories';
import { normalizeMountPath, validateMountPath } from './sync/mount-paths';

/**
 * A folder connection mounts another server vault ("shared vault") at a local
 * folder — e.g. a Reference/ folder shared between a personal and a work
 * vault. Per-device, like all settings. vmkB64 has the same trust model as
 * the main vault's cached VMK (docs/decisions.md).
 */
export interface FolderConnection {
  id: string;
  vaultId: string;
  vmkB64: string;
  vaultName: string;
  /** Normalized local mount path, e.g. 'Shared/Reference'. */
  localPath: string;
}

export interface VaultSyncSettings {
  serverUrl: string;
  deviceName: string;
  token: string | null;
  deviceId: string | null;
  vaultId: string | null;
  // Unwrapped vault master key, base64. Cached so mobile doesn't re-run the
  // 64 MiB Argon2id KDF on every launch; the passphrase itself is never
  // persisted. The device already holds the vault in plaintext, so local VMK
  // storage is not a weakening (docs/decisions.md).
  vmkB64: string | null;
  // Decrypted name of the connected vault, and names learned at unlock/create,
  // cached for display. Not a weakening: the device already holds the vault in
  // plaintext (docs/decisions.md); names never travel to the server unencrypted.
  vaultName: string | null;
  knownVaultNames: Record<string, string>;
  // Selective-sync size cap; 0 = unlimited. Files above it stop syncing on
  // this device (never deleted anywhere). The mobile default is the OOM
  // guard: Obsidian's file API is whole-file, so a file must fit in webview
  // memory at least once.
  maxFileSizeMB: number;
  // Concurrent file transfers (1..6). Large files (>32 MB) always transfer
  // one at a time regardless, bounding peak memory.
  parallelTransfers: number;
  // Selective sync by attachment category; notes always sync.
  syncCategories: CategoryToggles;
  // .obsidian settings sync: per-device opt-in (default off everywhere).
  // Disabling stops updates but never deletes anything (docs/decisions.md).
  settingsSyncEnabled: boolean;
  settingsSyncCategories: ConfigSyncToggles;
  // Additional server vaults mounted at local folders (see FolderConnection).
  folderConnections: FolderConnection[];
  // Pause switch: no pushes/pulls while true (status icon shows paused).
  paused: boolean;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
  serverUrl: '',
  deviceName: 'my-device',
  token: null,
  deviceId: null,
  vaultId: null,
  vmkB64: null,
  vaultName: null,
  knownVaultNames: {},
  maxFileSizeMB: Platform.isMobile ? 100 : 0,
  parallelTransfers: Platform.isMobile ? 2 : 4,
  syncCategories: { ...DEFAULT_CATEGORY_TOGGLES },
  settingsSyncEnabled: false,
  settingsSyncCategories: { ...DEFAULT_CONFIG_SYNC_TOGGLES },
  folderConnections: [],
  paused: false,
};

type SettingsTabId = 'connection' | 'vaultSync' | 'settingsSync';

const TABS: { id: SettingsTabId; label: string }[] = [
  { id: 'connection', label: 'Connection' },
  { id: 'vaultSync', label: 'Vault sync' },
  { id: 'settingsSync', label: 'Settings sync' },
];

export class VaultSyncSettingTab extends PluginSettingTab {
  private vaults: VaultSummary[] = [];
  private selectedVaultId: string | null = null;
  private selectedFolderVaultId: string | null = null;
  // Session-persistent: this.display() re-renders (after login/unlock/create)
  // land back on the tab the user was on.
  private activeTab: SettingsTabId = 'connection';
  // One vault-list fetch per pane open (reset in hide()); stops the
  // render → loadVaults → render cycle from looping.
  private vaultsRefreshedThisOpen = false;

  constructor(
    app: App,
    private plugin: VaultSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.renderTabBar(containerEl);
    const body = containerEl.createDiv();
    if (this.activeTab === 'connection') this.renderConnectionTab(body);
    else if (this.activeTab === 'vaultSync') this.renderVaultSyncTab(body);
    else this.renderSettingsSyncTab(body);
  }

  hide(): void {
    this.vaultsRefreshedThisOpen = false;
    super.hide();
  }

  /** Reload the vault list and re-render; fall back to a plain re-render offline. */
  private async refreshVaultsAndRender(): Promise<void> {
    try {
      await this.loadVaults();
    } catch {
      this.display();
    }
  }

  private renderTabBar(containerEl: HTMLElement): void {
    const bar = containerEl.createDiv({ cls: 'vault-sync-settings-tabs' });
    for (const { id, label } of TABS) {
      const button = bar.createEl('button', { text: label, cls: 'vault-sync-settings-tab' });
      button.toggleClass('is-active', id === this.activeTab);
      button.addEventListener('click', () => {
        this.activeTab = id;
        this.display();
      });
    }
  }

  // --- Connection tab: server, account, vault ------------------------------

  private renderConnectionTab(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Your vault-sync server (behind VPN or reverse proxy).')
      .addText((text) =>
        text
          .setPlaceholder('https://sync.example.com')
          .setValue(settings.serverUrl)
          .onChange(async (value) => {
            settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Device name')
      .setDesc('Shown in conflict filenames, version history, and the server device list.')
      .addText((text) =>
        text.setValue(settings.deviceName).onChange(async (value) => {
          settings.deviceName = value.trim() || 'my-device';
          await this.plugin.saveSettings();
          // Keep the server-side label current (it's otherwise only set at
          // login). Best-effort: offline just means the old name lingers.
          if (settings.token) {
            new RestClient(settings.serverUrl, settings.token)
              .renameDevice(settings.deviceName)
              .catch(() => {});
          }
        }),
      );

    // --- Account ---------------------------------------------------------
    let password = '';
    const account = new Setting(containerEl)
      .setName(settings.token ? 'Account: logged in' : 'Account password')
      .setDesc(
        settings.token
          ? `Logged in as "${settings.deviceName}". Re-login replaces this device registration.`
          : '',
      );
    if (settings.token && settings.deviceId) {
      account.addExtraButton((button) =>
        button
          .setIcon('copy')
          .setTooltip('Copy device ID')
          .onClick(async () => {
            await navigator.clipboard.writeText(settings.deviceId!);
            new Notice('vault-sync: device ID copied');
          }),
      );
    }
    account
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder('account password').onChange((v) => (password = v));
      })
      .addButton((button) =>
        button
          .setButtonText('Log in')
          .setCta()
          .onClick(async () => {
            try {
              const rest = new RestClient(settings.serverUrl);
              const res = await rest.login(password, settings.deviceName);
              settings.token = res.token;
              settings.deviceId = res.deviceId;
              await this.plugin.saveSettings();
              new Notice('vault-sync: logged in');
              await this.loadVaults();
            } catch (err) {
              new Notice(`vault-sync: login failed — ${(err as Error).message}`);
            }
          }),
      );

    if (!settings.token) return;

    // Refresh the vault list once per pane open so vaults created/disconnected
    // in another vault or on another device show up without a manual refresh.
    // The guard stops loadVaults()'s re-render from re-triggering the fetch.
    if (!this.vaultsRefreshedThisOpen) {
      this.vaultsRefreshedThisOpen = true;
      void this.loadVaults().catch(() => {});
    }

    // --- Vault selection ---------------------------------------------------
    const vaultSection = containerEl.createDiv();
    this.renderVaultSection(vaultSection);
  }

  // --- Vault sync tab: what syncs from the vault (local per-device policy) --

  private renderVaultSyncTab(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;

    new Setting(containerEl)
      .setName('Synced file types')
      .setDesc(
        `Notes, canvases and bases always sync (${NATIVE_EXTENSION_LIST.join(', ')}). ` +
          'Disabling a type stops syncing those files on this device — nothing is ever deleted.',
      )
      .setHeading();
    const categories: { key: keyof CategoryToggles; label: string; desc: string }[] = [
      { key: 'image', label: 'Images', desc: CATEGORY_EXTENSIONS.image.join(', ') },
      {
        key: 'audio',
        label: 'Audio',
        desc: `${CATEGORY_EXTENSIONS.audio.join(', ')} (webm syncs under Video)`,
      },
      { key: 'video', label: 'Video', desc: CATEGORY_EXTENSIONS.video.join(', ') },
      { key: 'pdf', label: 'PDFs', desc: CATEGORY_EXTENSIONS.pdf.join(', ') },
      {
        key: 'other',
        label: 'All other types',
        desc: 'Any extension not listed above (e.g. txt, json, csv, zip, docx, epub)',
      },
    ];
    for (const { key, label, desc } of categories) {
      new Setting(containerEl)
        .setName(label)
        .setDesc(desc)
        .addToggle((toggle) =>
          toggle.setValue(settings.syncCategories[key]).onChange(async (value) => {
            settings.syncCategories[key] = value;
            await this.plugin.saveSettings();
          }),
        );
    }

    new Setting(containerEl).setName('Transfers').setHeading();
    new Setting(containerEl)
      .setName('Max synced file size (MB)')
      .setDesc(
        'Files larger than this stop syncing on this device (never deleted). 0 = unlimited. ' +
          'Large files must fit in memory during sync — keep a cap on mobile.',
      )
      .addText((text) =>
        text.setValue(String(settings.maxFileSizeMB)).onChange(async (value) => {
          const parsed = Number(value);
          if (Number.isFinite(parsed) && parsed >= 0) {
            settings.maxFileSizeMB = Math.floor(parsed);
            await this.plugin.saveSettings();
          }
        }),
      );
    new Setting(containerEl)
      .setName('Parallel transfers')
      .setDesc('Concurrent file uploads/downloads. Files over 32 MB always go one at a time.')
      .addSlider((slider) =>
        slider
          .setLimits(1, 6, 1)
          .setValue(settings.parallelTransfers)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.parallelTransfers = value;
            await this.plugin.saveSettings();
          }),
      );
  }

  // --- Settings sync tab: .obsidian configuration --------------------------

  private renderSettingsSyncTab(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;

    new Setting(containerEl)
      .setName('Sync Obsidian settings on this device')
      .setDesc(
        'Off by default — enable per device. Turning it off stops updates but never deletes ' +
          'anything. Changes pulled from other devices apply after you reload Obsidian. When ' +
          'settings conflict, the newest change wins; the other version stays in version history.',
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.settingsSyncEnabled).onChange(async (value) => {
          settings.settingsSyncEnabled = value;
          await this.plugin.saveSettings();
          this.display();
          if (value) void this.plugin.syncNow(false);
        }),
      );

    // Granularity mirrors Obsidian Sync's vault-configuration options.
    const configCategories: { key: keyof ConfigSyncToggles; label: string; desc: string }[] = [
      { key: 'mainSettings', label: 'Main settings', desc: 'app.json — editor, files & links' },
      {
        key: 'appearance',
        label: 'Appearance',
        desc: 'appearance.json — theme choice, fonts, interface',
      },
      { key: 'themesSnippets', label: 'Themes and snippets', desc: 'themes and CSS snippets' },
      { key: 'hotkeys', label: 'Hotkeys', desc: 'hotkeys.json' },
      { key: 'corePluginList', label: 'Active core plugin list', desc: 'core-plugins.json' },
      {
        key: 'corePluginSettings',
        label: 'Core plugin settings',
        desc: 'graph.json, daily-notes.json, and any other Obsidian config files',
      },
      {
        key: 'communityPluginList',
        label: 'Active community plugin list',
        desc: 'community-plugins.json',
      },
      {
        key: 'communityPluginSettings',
        label: 'Community plugin settings',
        desc:
          'Each plugin’s data.json. May contain other plugins’ API tokens — stored ' +
          'end-to-end encrypted on your server.',
      },
      {
        key: 'communityPlugins',
        label: 'Installed community plugins',
        desc:
          'main.js, manifest, and styles — installed plugins follow you across devices. ' +
          'Synced code runs on this device; mobile users usually leave this off.',
      },
    ];
    for (const { key, label, desc } of configCategories) {
      new Setting(containerEl)
        .setName(label)
        .setDesc(desc)
        .setDisabled(!settings.settingsSyncEnabled)
        .addToggle((toggle) => {
          toggle.setValue(settings.settingsSyncCategories[key]).onChange(async (value) => {
            settings.settingsSyncCategories[key] = value;
            await this.plugin.saveSettings();
          });
          toggle.setDisabled(!settings.settingsSyncEnabled);
        });
    }
  }

  private async loadVaults(): Promise<void> {
    const { serverUrl, token } = this.plugin.settings;
    this.vaults = (await new RestClient(serverUrl, token).listVaults()).vaults;
    this.display();
  }

  /** Unwrap a vault's VMK from its passphrase; shared by the main vault and folder connections. */
  private unlockVaultKey(
    summary: VaultSummary,
    passphrase: string,
  ): { vaultId: string; vmkB64: string; vaultName: string } {
    const vmk = unwrapVmk({ kdf: summary.kdf, wrappedVmkB64: summary.wrappedVmkB64 }, passphrase);
    const sodium = getSodium();
    const vaultName = decryptVaultName(deriveVaultKeys(vmk), summary.encryptedNameB64);
    return {
      vaultId: summary.id,
      vmkB64: sodium.to_base64(vmk, sodium.base64_variants.ORIGINAL),
      vaultName,
    };
  }

  /** Create a new server vault; shared by the main vault and folder connections. */
  private async createVaultOnServer(
    name: string,
    passphrase: string,
    kind: VaultKind,
  ): Promise<{ vaultId: string; vmkB64: string; vaultName: string }> {
    const settings = this.plugin.settings;
    const vmk = generateVmk();
    const envelope = createEnvelope(vmk, passphrase);
    const keys = deriveVaultKeys(vmk);
    const rest = new RestClient(settings.serverUrl, settings.token);
    const { id } = await rest.createVault({
      encryptedNameB64: encryptVaultName(keys, name),
      kdf: envelope.kdf,
      wrappedVmkB64: envelope.wrappedVmkB64,
      kind,
    });
    const sodium = getSodium();
    return {
      vaultId: id,
      vmkB64: sodium.to_base64(vmk, sodium.base64_variants.ORIGINAL),
      vaultName: name,
    };
  }

  private renderVaultSection(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;

    new Setting(containerEl).setName('Vault').setHeading();

    const connected = new Setting(containerEl).setName(
      settings.vaultId
        ? `Connected to "${settings.vaultName ?? `vault ${settings.vaultId.slice(0, 8)}…`}"`
        : 'No vault connected',
    );
    if (settings.vaultId) {
      connected.addExtraButton((button) =>
        button
          .setIcon('copy')
          .setTooltip('Copy vault ID')
          .onClick(async () => {
            await navigator.clipboard.writeText(settings.vaultId!);
            new Notice('vault-sync: vault ID copied');
          }),
      );
    }
    connected.addButton((button) =>
      button
        .setButtonText('Refresh vault list')
        .setTooltip('The list refreshes automatically when settings open; use this to force it now')
        .onClick(async () => {
          try {
            await this.loadVaults();
          } catch (err) {
            new Notice(`vault-sync: ${(err as Error).message}`);
          }
        }),
    );

    // Full vaults only — folder-share vaults are mounted from the Folder
    // connections section below, not opened as a whole vault.
    const fullVaults = this.vaults.filter((v) => v.kind !== 'folder');
    if (fullVaults.length > 0) {
      let passphrase = '';
      const setting = new Setting(containerEl)
        .setName('Connect to existing vault')
        .setDesc(
          'Names are end-to-end encrypted and decrypt after you unlock; ' +
            'vaults unlocked before on this device show their name.',
        );
      setting.addDropdown((dropdown) => {
        for (const vault of fullVaults) {
          dropdown.addOption(
            vault.id,
            settings.knownVaultNames[vault.id] ??
              `Vault created ${vault.createdAt.slice(0, 10)} (${vault.id.slice(0, 8)})`,
          );
        }
        this.selectedVaultId = fullVaults[0]?.id ?? null;
        dropdown.onChange((value) => (this.selectedVaultId = value));
      });
      setting.addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder('vault passphrase').onChange((v) => (passphrase = v));
      });
      setting.addButton((button) =>
        button
          .setButtonText('Unlock')
          .setCta()
          .onClick(async () => {
            const summary = this.vaults.find((v) => v.id === this.selectedVaultId);
            if (!summary) return;
            try {
              const { vaultId, vmkB64, vaultName } = this.unlockVaultKey(summary, passphrase);
              settings.vaultId = vaultId;
              settings.vmkB64 = vmkB64;
              settings.vaultName = vaultName;
              settings.knownVaultNames[vaultId] = vaultName;
              await this.plugin.saveSettings();
              new Notice(`vault-sync: unlocked "${vaultName}" — starting sync`);
              await this.plugin.startSync();
              this.display();
            } catch (err) {
              new Notice(
                err instanceof WrongPassphraseError
                  ? 'vault-sync: wrong passphrase'
                  : `vault-sync: ${(err as Error).message}`,
              );
            }
          }),
      );
    }

    let newName = '';
    let newPassphrase = '';
    const create = new Setting(containerEl)
      .setName('Create new vault')
      .setDesc('The passphrase never leaves this device. There is no recovery if lost.');
    create.addText((text) => text.setPlaceholder('vault name').onChange((v) => (newName = v)));
    create.addText((text) => {
      text.inputEl.type = 'password';
      text.setPlaceholder('new passphrase').onChange((v) => (newPassphrase = v));
    });
    create.addButton((button) =>
      button.setButtonText('Create').onClick(async () => {
        if (!newName || newPassphrase.length < 8) {
          new Notice('vault-sync: need a name and a passphrase of 8+ characters');
          return;
        }
        try {
          const { vaultId, vmkB64, vaultName } = await this.createVaultOnServer(
            newName,
            newPassphrase,
            'vault',
          );
          settings.vaultId = vaultId;
          settings.vmkB64 = vmkB64;
          settings.vaultName = vaultName;
          settings.knownVaultNames[vaultId] = vaultName;
          await this.plugin.saveSettings();
          new Notice(`vault-sync: created "${vaultName}" — starting sync`);
          await this.plugin.startSync();
          this.display();
        } catch (err) {
          new Notice(`vault-sync: ${(err as Error).message}`);
        }
      }),
    );

    if (settings.vaultId) {
      new Setting(containerEl)
        .setName('Sync')
        .setDesc(settings.paused ? 'Sync is paused — resume from the status bar icon.' : '')
        .addButton((button) =>
          button
            .setButtonText('Sync now')
            .setCta()
            .onClick(() => this.plugin.syncNow()),
        );
      this.renderManageVault(containerEl);
    }

    this.renderFolderConnections(containerEl);
  }

  /**
   * Lifecycle controls for the connected main vault: rename, change passphrase,
   * disconnect (local only), delete (server-side). Edit/delete are gated on the
   * vault passphrase (verified client-side via unwrapVmk); the server only ever
   * sees the re-encrypted name / re-wrapped VMK / a delete by id.
   */
  private renderManageVault(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    const vaultId = settings.vaultId;
    if (!vaultId) return;

    new Setting(containerEl)
      .setName('Manage vault')
      .setDesc(
        'Rename, change passphrase, or delete this vault. Edit and delete need ' +
          'the current passphrase. Refresh the vault list if these do nothing.',
      )
      .setHeading();

    // The current server envelope (kdf, wrapped VMK, encrypted name) — needed to
    // verify the passphrase and to re-encrypt. Absent until the list is loaded.
    const summary = (): VaultSummary | undefined =>
      this.vaults.find((v) => v.id === vaultId);
    const requireSummary = (): VaultSummary | null => {
      const s = summary();
      if (!s) {
        new Notice('vault-sync: refresh the vault list first');
        return null;
      }
      return s;
    };

    // --- Rename ---------------------------------------------------------------
    {
      let newName = '';
      let passphrase = '';
      const rename = new Setting(containerEl).setName('Rename vault');
      rename.addText((text) => text.setPlaceholder('new name').onChange((v) => (newName = v)));
      rename.addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder('passphrase').onChange((v) => (passphrase = v));
      });
      rename.addButton((button) =>
        button.setButtonText('Rename').onClick(async () => {
          const s = requireSummary();
          if (!s) return;
          if (!newName) {
            new Notice('vault-sync: enter a new name');
            return;
          }
          try {
            const vmk = unwrapVmk({ kdf: s.kdf, wrappedVmkB64: s.wrappedVmkB64 }, passphrase);
            const encryptedNameB64 = encryptVaultName(deriveVaultKeys(vmk), newName);
            await new RestClient(settings.serverUrl, settings.token).updateVault(vaultId, {
              encryptedNameB64,
            });
            settings.vaultName = newName;
            settings.knownVaultNames[vaultId] = newName;
            await this.plugin.saveSettings();
            new Notice(`vault-sync: renamed to "${newName}"`);
            await this.refreshVaultsAndRender();
          } catch (err) {
            new Notice(
              err instanceof WrongPassphraseError
                ? 'vault-sync: wrong passphrase'
                : `vault-sync: ${(err as Error).message}`,
            );
          }
        }),
      );
    }

    // --- Change passphrase ----------------------------------------------------
    {
      let oldPassphrase = '';
      let newPassphrase = '';
      const change = new Setting(containerEl)
        .setName('Change passphrase')
        .setDesc('Re-wraps the vault key. Other devices need the new passphrase to unlock.');
      change.addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder('current passphrase').onChange((v) => (oldPassphrase = v));
      });
      change.addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder('new passphrase').onChange((v) => (newPassphrase = v));
      });
      change.addButton((button) =>
        button.setButtonText('Change').onClick(async () => {
          const s = requireSummary();
          if (!s) return;
          if (newPassphrase.length < 8) {
            new Notice('vault-sync: new passphrase must be 8+ characters');
            return;
          }
          try {
            const envelope = rewrapVmk(
              { kdf: s.kdf, wrappedVmkB64: s.wrappedVmkB64 },
              oldPassphrase,
              newPassphrase,
            );
            await new RestClient(settings.serverUrl, settings.token).updateVault(vaultId, {
              kdf: envelope.kdf,
              wrappedVmkB64: envelope.wrappedVmkB64,
            });
            // VMK unchanged: cached vmkB64 and the live connection keep working.
            new Notice('vault-sync: passphrase changed');
            await this.refreshVaultsAndRender();
          } catch (err) {
            new Notice(
              err instanceof WrongPassphraseError
                ? 'vault-sync: wrong current passphrase'
                : `vault-sync: ${(err as Error).message}`,
            );
          }
        }),
      );
    }

    // --- Disconnect (local only, no passphrase) -------------------------------
    this.renderDisconnectVault(containerEl, vaultId);

    // --- Delete (server-side, passphrase + typed confirm) ---------------------
    this.renderDeleteVault(containerEl, vaultId, requireSummary);
  }

  /** Two-step inline confirm; clears local connection state, leaves files and the server vault. */
  private renderDisconnectVault(containerEl: HTMLElement, vaultId: string): void {
    const settings = this.plugin.settings;
    const disconnect = new Setting(containerEl)
      .setName('Disconnect vault')
      .setDesc('Stops syncing on this device. Files stay in the vault; the server vault is untouched.');
    disconnect.addButton((button) =>
      button.setButtonText('Disconnect').onClick(() => {
        disconnect.clear();
        disconnect.setName('Disconnect this vault?');
        disconnect.addButton((confirm) =>
          confirm
            .setButtonText('Disconnect')
            .setWarning()
            .onClick(async () => {
              confirm.setDisabled(true);
              settings.vaultId = null;
              settings.vmkB64 = null;
              settings.vaultName = null;
              await this.plugin.saveSettings();
              await this.forgetConnectionState(vaultId);
              new Notice('vault-sync: disconnected — files stay put, the server vault is untouched');
              await this.plugin.startSync();
              await this.refreshVaultsAndRender();
            }),
        );
        disconnect.addButton((cancel) =>
          cancel.setButtonText('Cancel').onClick(() => {
            disconnect.settingEl.remove();
            this.renderDisconnectVault(containerEl, vaultId);
          }),
        );
      }),
    );
  }

  /** Passphrase + typed confirmation, then a two-step inline confirm. Irreversible. */
  private renderDeleteVault(
    containerEl: HTMLElement,
    vaultId: string,
    requireSummary: () => VaultSummary | null,
  ): void {
    const settings = this.plugin.settings;
    let passphrase = '';
    let typed = '';
    const del = new Setting(containerEl)
      .setName('Delete vault')
      .setDesc(
        'Permanently deletes the vault and all its history on the server. Cannot be undone. ' +
          'Enter the passphrase and type the vault name (or "delete") to confirm.',
      );
    del.addText((text) => {
      text.inputEl.type = 'password';
      text.setPlaceholder('passphrase').onChange((v) => (passphrase = v));
    });
    del.addText((text) =>
      text.setPlaceholder('vault name or "delete"').onChange((v) => (typed = v)),
    );
    del.addButton((button) =>
      button
        .setButtonText('Delete')
        .setWarning()
        .onClick(() => {
          const s = requireSummary();
          if (!s) return;
          const confirmMatches =
            typed === settings.vaultName || typed.trim().toLowerCase() === 'delete';
          if (!confirmMatches) {
            new Notice('vault-sync: type the vault name or "delete" to confirm');
            return;
          }
          try {
            // Verify the passphrase before offering the irreversible step.
            unwrapVmk({ kdf: s.kdf, wrappedVmkB64: s.wrappedVmkB64 }, passphrase);
          } catch (err) {
            new Notice(
              err instanceof WrongPassphraseError
                ? 'vault-sync: wrong passphrase'
                : `vault-sync: ${(err as Error).message}`,
            );
            return;
          }
          const name = settings.vaultName ?? `vault ${vaultId.slice(0, 8)}…`;
          del.clear();
          del.setName(`Permanently delete "${name}"?`);
          del.setDesc('This cannot be undone.');
          del.addButton((confirm) =>
            confirm
              .setButtonText('Delete forever')
              .setWarning()
              .onClick(async () => {
                confirm.setDisabled(true);
                try {
                  await new RestClient(settings.serverUrl, settings.token).deleteVault(vaultId);
                  settings.vaultId = null;
                  settings.vmkB64 = null;
                  settings.vaultName = null;
                  await this.plugin.saveSettings();
                  await this.forgetConnectionState(vaultId);
                  new Notice(`vault-sync: deleted "${name}"`);
                  await this.plugin.startSync();
                  await this.refreshVaultsAndRender();
                } catch (err) {
                  new Notice(`vault-sync: ${(err as Error).message}`);
                  confirm.setDisabled(false);
                }
              }),
          );
          del.addButton((cancel) =>
            cancel.setButtonText('Cancel').onClick(() => {
              del.settingEl.remove();
              this.renderDeleteVault(containerEl, vaultId, requireSummary);
            }),
          );
        }),
    );
  }

  // --- Folder connections: mount other server vaults at local folders -----

  private renderFolderConnections(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;

    new Setting(containerEl)
      .setName('Folder connections')
      .setDesc(
        'Mount another server vault at a folder in this vault — the same shared vault can be ' +
          'mounted in several Obsidian vaults, so its contents stay identical everywhere. ' +
          'Existing files in the folder merge with the shared vault when you connect.',
      )
      .setHeading();

    for (const fc of settings.folderConnections) {
      const missing = this.app.vault.getFolderByPath(fc.localPath) === null;
      const row = new Setting(containerEl)
        .setName(`"${fc.vaultName}" → ${fc.localPath}/`)
        .setDesc(missing ? 'Folder missing on this device — sync paused for this connection.' : '');
      row.addExtraButton((button) =>
        button
          .setIcon('copy')
          .setTooltip('Copy vault ID')
          .onClick(async () => {
            await navigator.clipboard.writeText(fc.vaultId);
            new Notice('vault-sync: vault ID copied');
          }),
      );
      row.addButton((button) =>
        button.setButtonText('Disconnect').onClick(async () => {
          settings.folderConnections = settings.folderConnections.filter((c) => c.id !== fc.id);
          await this.plugin.saveSettings();
          await this.forgetConnectionState(fc.vaultId);
          new Notice(
            `vault-sync: disconnected "${fc.vaultName}" — files stay in ${fc.localPath}/; ` +
              'the shared vault is untouched',
          );
          await this.plugin.startSync();
          await this.refreshVaultsAndRender();
        }),
      );
    }

    if (this.vaults.length > 0) {
      const connectableVaults = this.vaults.filter(
        (v) =>
          v.kind === 'folder' &&
          v.id !== settings.vaultId &&
          !settings.folderConnections.some((c) => c.vaultId === v.id),
      );
      if (connectableVaults.length > 0) {
        let passphrase = '';
        let localPath = '';
        const add = new Setting(containerEl)
          .setName('Add folder connection')
          .setDesc('Pick a shared vault, its passphrase, and where it should live in this vault.');
        add.addDropdown((dropdown) => {
          for (const vault of connectableVaults) {
            dropdown.addOption(
              vault.id,
              settings.knownVaultNames[vault.id] ??
                `Vault created ${vault.createdAt.slice(0, 10)} (${vault.id.slice(0, 8)})`,
            );
          }
          this.selectedFolderVaultId = connectableVaults[0]?.id ?? null;
          dropdown.onChange((value) => (this.selectedFolderVaultId = value));
        });
        add.addText((text) => {
          text.inputEl.type = 'password';
          text.setPlaceholder('vault passphrase').onChange((v) => (passphrase = v));
        });
        add.addText((text) =>
          text.setPlaceholder('local folder (e.g. Reference)').onChange((v) => (localPath = v)),
        );
        add.addButton((button) =>
          button
            .setButtonText('Connect')
            .setCta()
            .onClick(async () => {
              const summary = connectableVaults.find((v) => v.id === this.selectedFolderVaultId);
              if (!summary) return;
              const normalized = normalizeMountPath(localPath);
              if (!normalized) {
                new Notice('vault-sync: enter a valid local folder (not empty, not .obsidian)');
                return;
              }
              const overlap = validateMountPath(
                normalized,
                settings.folderConnections.map((c) => c.localPath),
              );
              if (overlap) {
                new Notice(`vault-sync: ${overlap}`);
                return;
              }
              try {
                const unlocked = this.unlockVaultKey(summary, passphrase);
                await this.addFolderConnection(unlocked, normalized);
              } catch (err) {
                new Notice(
                  err instanceof WrongPassphraseError
                    ? 'vault-sync: wrong passphrase'
                    : `vault-sync: ${(err as Error).message}`,
                );
              }
            }),
        );
      }
    }

    let newName = '';
    let newPassphrase = '';
    let newLocalPath = '';
    const create = new Setting(containerEl)
      .setName('Create a new shared vault')
      .setDesc('The passphrase never leaves this device. There is no recovery if lost.');
    create.addText((text) =>
      text.setPlaceholder('shared vault name').onChange((v) => (newName = v)),
    );
    create.addText((text) => {
      text.inputEl.type = 'password';
      text.setPlaceholder('new passphrase').onChange((v) => (newPassphrase = v));
    });
    create.addText((text) =>
      text.setPlaceholder('local folder (e.g. Reference)').onChange((v) => (newLocalPath = v)),
    );
    create.addButton((button) =>
      button.setButtonText('Create').onClick(async () => {
        if (!newName || newPassphrase.length < 8) {
          new Notice('vault-sync: need a name and a passphrase of 8+ characters');
          return;
        }
        const normalized = normalizeMountPath(newLocalPath);
        if (!normalized) {
          new Notice('vault-sync: enter a valid local folder (not empty, not .obsidian)');
          return;
        }
        const overlap = validateMountPath(
          normalized,
          settings.folderConnections.map((c) => c.localPath),
        );
        if (overlap) {
          new Notice(`vault-sync: ${overlap}`);
          return;
        }
        try {
          const created = await this.createVaultOnServer(newName, newPassphrase, 'folder');
          await this.addFolderConnection(created, normalized);
        } catch (err) {
          new Notice(`vault-sync: ${(err as Error).message}`);
        }
      }),
    );
  }

  private async addFolderConnection(
    unlocked: { vaultId: string; vmkB64: string; vaultName: string },
    localPath: string,
  ): Promise<void> {
    const settings = this.plugin.settings;
    if (!this.app.vault.getFolderByPath(localPath)) {
      await this.app.vault.createFolder(localPath);
    }
    settings.folderConnections.push({
      id: crypto.randomUUID(),
      vaultId: unlocked.vaultId,
      vmkB64: unlocked.vmkB64,
      vaultName: unlocked.vaultName,
      localPath,
    });
    settings.knownVaultNames[unlocked.vaultId] = unlocked.vaultName;
    await this.plugin.saveSettings();
    new Notice(
      `vault-sync: connected "${unlocked.vaultName}" at ${localPath}/ — existing files will merge with the shared vault`,
    );
    await this.plugin.startSync();
    await this.refreshVaultsAndRender();
  }

  /** Best-effort cleanup of a disconnected connection's local sync state. */
  private async forgetConnectionState(vaultId: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const pluginDir = this.plugin.manifest.dir;
    if (!pluginDir) return;
    try {
      const indexFile = `${pluginDir}/sync-index-${vaultId}.json`;
      if (await adapter.exists(indexFile)) await adapter.remove(indexFile);
      const spoolDir = `${pluginDir}/spool/${vaultId}`;
      if (await adapter.exists(spoolDir)) await adapter.rmdir(spoolDir, true);
    } catch {
      // best-effort cache cleanup only
    }
  }
}
