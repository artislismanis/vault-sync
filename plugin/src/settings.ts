import { App, PluginSettingTab, Setting } from 'obsidian';
import type VaultSyncPlugin from './main';

export interface VaultSyncSettings {
  serverUrl: string;
  deviceName: string;
  vaultId: string | null;
  // The E2EE passphrase is deliberately NOT persisted here in plaintext;
  // key-handling strategy lands with the sync engine.
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
  serverUrl: '',
  deviceName: '',
  vaultId: null,
};

export class VaultSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: VaultSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Your vault-sync server (behind VPN or reverse proxy).')
      .addText((text) =>
        text
          .setPlaceholder('https://sync.example.com')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    // Onboarding flow (login → pick/create vault → passphrase → folder)
    // lands with the transport layer.
  }
}
