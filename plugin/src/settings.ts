import { App, Notice, Platform, PluginSettingTab, Setting } from 'obsidian';
import {
  createEnvelope,
  decryptVaultName,
  deriveVaultKeys,
  encryptVaultName,
  generateVmk,
  getSodium,
  unwrapVmk,
  VaultSummary,
  WrongPassphraseError,
} from '@vault-sync/shared';
import type VaultSyncPlugin from './main';
import { RestClient } from './transport/rest';

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
  // Selective-sync size cap; 0 = unlimited. Files above it stop syncing on
  // this device (never deleted anywhere). The mobile default is the OOM
  // guard: Obsidian's file API is whole-file, so a file must fit in webview
  // memory at least once.
  maxFileSizeMB: number;
  // Concurrent file transfers (1..6). Large files (>32 MB) always transfer
  // one at a time regardless, bounding peak memory.
  parallelTransfers: number;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
  serverUrl: '',
  deviceName: 'my-device',
  token: null,
  deviceId: null,
  vaultId: null,
  vmkB64: null,
  maxFileSizeMB: Platform.isMobile ? 100 : 0,
  parallelTransfers: Platform.isMobile ? 2 : 4,
};

export class VaultSyncSettingTab extends PluginSettingTab {
  private vaults: VaultSummary[] = [];
  private selectedVaultId: string | null = null;

  constructor(
    app: App,
    private plugin: VaultSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
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
      .setDesc('Shown in conflict filenames and the server device list.')
      .addText((text) =>
        text.setValue(settings.deviceName).onChange(async (value) => {
          settings.deviceName = value.trim() || 'my-device';
          await this.plugin.saveSettings();
        }),
      );

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

    // --- Account ---------------------------------------------------------
    let password = '';
    new Setting(containerEl)
      .setName(settings.token ? 'Account: logged in' : 'Account password')
      .setDesc(settings.token ? 'Re-login replaces this device registration.' : '')
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

    // --- Vault selection ---------------------------------------------------
    const vaultSection = containerEl.createDiv();
    this.renderVaultSection(vaultSection);
  }

  private async loadVaults(): Promise<void> {
    const { serverUrl, token } = this.plugin.settings;
    this.vaults = (await new RestClient(serverUrl, token).listVaults()).vaults;
    this.display();
  }

  private renderVaultSection(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;

    new Setting(containerEl).setName('Vault').setHeading();

    new Setting(containerEl)
      .setName(
        settings.vaultId
          ? `Connected to vault ${settings.vaultId.slice(0, 8)}…`
          : 'No vault connected',
      )
      .addButton((button) =>
        button.setButtonText('Refresh vault list').onClick(async () => {
          try {
            await this.loadVaults();
          } catch (err) {
            new Notice(`vault-sync: ${(err as Error).message}`);
          }
        }),
      );

    if (this.vaults.length > 0) {
      let passphrase = '';
      const setting = new Setting(containerEl)
        .setName('Connect to existing vault')
        .setDesc('Names are end-to-end encrypted; they decrypt after you unlock.');
      setting.addDropdown((dropdown) => {
        for (const vault of this.vaults) {
          dropdown.addOption(
            vault.id,
            `${vault.id.slice(0, 8)}… (created ${vault.createdAt.slice(0, 10)})`,
          );
        }
        this.selectedVaultId = this.vaults[0]?.id ?? null;
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
              const vmk = unwrapVmk(
                { kdf: summary.kdf, wrappedVmkB64: summary.wrappedVmkB64 },
                passphrase,
              );
              const sodium = getSodium();
              settings.vaultId = summary.id;
              settings.vmkB64 = sodium.to_base64(vmk, sodium.base64_variants.ORIGINAL);
              await this.plugin.saveSettings();
              const name = decryptVaultName(deriveVaultKeys(vmk), summary.encryptedNameB64);
              new Notice(`vault-sync: unlocked "${name}" — starting sync`);
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
          const vmk = generateVmk();
          const envelope = createEnvelope(vmk, newPassphrase);
          const keys = deriveVaultKeys(vmk);
          const rest = new RestClient(settings.serverUrl, settings.token);
          const { id } = await rest.createVault({
            encryptedNameB64: encryptVaultName(keys, newName),
            kdf: envelope.kdf,
            wrappedVmkB64: envelope.wrappedVmkB64,
          });
          const sodium = getSodium();
          settings.vaultId = id;
          settings.vmkB64 = sodium.to_base64(vmk, sodium.base64_variants.ORIGINAL);
          await this.plugin.saveSettings();
          new Notice(`vault-sync: created "${newName}" — starting sync`);
          await this.plugin.startSync();
          this.display();
        } catch (err) {
          new Notice(`vault-sync: ${(err as Error).message}`);
        }
      }),
    );

    if (settings.vaultId) {
      new Setting(containerEl).setName('Sync').addButton((button) =>
        button
          .setButtonText('Sync now')
          .setCta()
          .onClick(() => this.plugin.syncNow()),
      );
    }
  }
}
