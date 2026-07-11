import { Plugin } from 'obsidian';
import { initSodium } from '@vault-sync/shared';
import { DEFAULT_SETTINGS, VaultSyncSettings, VaultSyncSettingTab } from './settings';

export default class VaultSyncPlugin extends Plugin {
  settings: VaultSyncSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    // Crypto must be ready before ANY sync activity — single init point.
    await initSodium();
    await this.loadSettings();
    this.addSettingTab(new VaultSyncSettingTab(this.app, this));

    // Sync engine start lands here: reconcile on layout-ready (covers mobile
    // cold start on foreground), subscribe to vault events, open transport.
  }

  onunload(): void {
    // Transport teardown lands with the sync engine.
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
