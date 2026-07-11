import { Notice, Plugin } from 'obsidian';
import { deriveVaultKeys, getSodium, initSodium } from '@vault-sync/shared';
import { DEFAULT_SETTINGS, VaultSyncSettings, VaultSyncSettingTab } from './settings';
import { RestClient } from './transport/rest';
import { ChangeChannel } from './transport/ws';
import { IndexStore } from './sync/index-store';
import { ChunkSpool } from './sync/spool';
import { SyncEngine } from './sync/engine';

const SYNC_DEBOUNCE_MS = 2_000;
const PERIODIC_RESCAN_MS = 5 * 60 * 1000;

export default class VaultSyncPlugin extends Plugin {
  settings: VaultSyncSettings = DEFAULT_SETTINGS;
  private engine: SyncEngine | null = null;
  private channel: ChangeChannel | null = null;
  private debounceTimer: number | null = null;
  private statusBar: HTMLElement | null = null;
  private progressNotice: Notice | null = null;

  async onload(): Promise<void> {
    // Crypto must be ready before ANY sync activity — single init point.
    await initSodium();
    await this.loadSettings();
    this.addSettingTab(new VaultSyncSettingTab(this.app, this));

    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => this.syncNow(),
    });

    if (this.settings.token && this.settings.vaultId && this.settings.vmkB64) {
      // Sync from a clean layout state; onLayoutReady also covers mobile
      // cold-start-on-foreground (hard rule 2).
      this.app.workspace.onLayoutReady(() => void this.startSync());
    }
  }

  onunload(): void {
    this.channel?.disconnect();
  }

  async startSync(): Promise<void> {
    const { serverUrl, token, vaultId, vmkB64, deviceName } = this.settings;
    if (!serverUrl || !token || !vaultId || !vmkB64) return;

    this.channel?.disconnect();

    const sodium = getSodium();
    const keys = deriveVaultKeys(sodium.from_base64(vmkB64, sodium.base64_variants.ORIGINAL));
    const rest = new RestClient(serverUrl, token);
    const index = IndexStore.forVault(this.app.vault.adapter, this.manifest.dir!, vaultId);
    await index.load();

    this.statusBar ??= this.addStatusBarItem();

    this.engine = new SyncEngine({
      vault: this.app.vault,
      rest,
      keys,
      vaultId,
      deviceName,
      index,
      // Getters, not snapshots: settings changes apply on the very next sync.
      getMaxFileSizeBytes: () => this.settings.maxFileSizeMB * 1024 * 1024,
      getParallelTransfers: () => this.settings.parallelTransfers,
      spool: new ChunkSpool(this.app.vault.adapter, `${this.manifest.dir}/spool`),
      log: (message) => console.log(`[vault-sync] ${message}`),
      notify: (message) => new Notice(message),
      status: (message) => this.setStatus(message),
    });

    // Local change sources: vault events (debounced)…
    const onVaultEvent = () => {
      if (!this.engine?.applyingRemote) this.scheduleSync();
    };
    this.registerEvent(this.app.vault.on('create', onVaultEvent));
    this.registerEvent(this.app.vault.on('modify', onVaultEvent));
    this.registerEvent(this.app.vault.on('delete', onVaultEvent));
    this.registerEvent(this.app.vault.on('rename', onVaultEvent));
    // …periodic rescan for external edits Obsidian didn't notice…
    this.registerInterval(
      window.setInterval(() => void this.engine?.requestSync(), PERIODIC_RESCAN_MS),
    );
    // …and server push notifications for remote changes.
    this.channel = new ChangeChannel(serverUrl, token, vaultId, (notification) => {
      if (notification.originDeviceId !== this.settings.deviceId) this.scheduleSync();
    });
    this.channel.connect();

    await this.syncNow();
  }

  private scheduleSync(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.engine?.requestSync();
    }, SYNC_DEBOUNCE_MS);
  }

  async syncNow(): Promise<void> {
    if (!this.engine) {
      new Notice('vault-sync: not configured — connect a vault in settings');
      return;
    }
    try {
      const changes = await this.engine.requestSync();
      new Notice(changes === 0 ? 'vault-sync: up to date' : `vault-sync: ${changes} change(s) synced`);
    } catch (err) {
      console.error('[vault-sync] sync failed', err);
      new Notice(`vault-sync: sync failed — ${(err as Error).message}`);
    }
  }

  /**
   * Live progress: status bar on desktop; on mobile (no status bar) a single
   * persistent Notice that updates in place during long transfers.
   */
  private setStatus(message: string | null): void {
    this.statusBar?.setText(message ?? 'vault-sync: idle');
    const isTransfer = message?.includes('chunk') ?? false;
    if (isTransfer) {
      if (this.progressNotice) {
        this.progressNotice.setMessage(message!);
      } else {
        this.progressNotice = new Notice(message!, 0);
      }
    } else if (this.progressNotice) {
      this.progressNotice.hide();
      this.progressNotice = null;
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
