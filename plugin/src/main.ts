import { Menu, Notice, Plugin, setIcon, TFile } from 'obsidian';
import { deriveVaultKeys, getSodium, initSodium } from '@vault-sync/shared';
import { DEFAULT_SETTINGS, VaultSyncSettings, VaultSyncSettingTab } from './settings';
import { RestClient } from './transport/rest';
import { ChangeChannel } from './transport/ws';
import { IndexStore } from './sync/index-store';
import { ChunkSpool } from './sync/spool';
import { SyncEngine } from './sync/engine';
import { isCategoryExcluded } from './sync/categories';
import { ActivityEntry, ActivityModal, HistoryModal } from './ui/modals';

const SYNC_DEBOUNCE_MS = 2_000;
const PERIODIC_RESCAN_MS = 5 * 60 * 1000;
// Pull cadence when the WebSocket can't connect (proxies, VPNs, mobile).
const POLLING_FALLBACK_MS = 60 * 1000;
const ACTIVITY_LOG_LIMIT = 200;

export default class VaultSyncPlugin extends Plugin {
  settings: VaultSyncSettings = DEFAULT_SETTINGS;
  private engine: SyncEngine | null = null;
  private channel: ChangeChannel | null = null;
  private debounceTimer: number | null = null;
  private statusBar: HTMLElement | null = null;
  private progressNotice: Notice | null = null;
  private activity: ActivityEntry[] = [];
  private syncState: 'idle' | 'syncing' | 'error' | 'paused' = 'idle';
  private lastSyncAt: Date | null = null;
  private lastError: string | null = null;
  private currentDetail: string | null = null;

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
    this.addCommand({
      id: 'activity-log',
      name: 'Show sync activity',
      callback: () => new ActivityModal(this.app, this.activity).open(),
    });
    this.addCommand({
      id: 'toggle-pause',
      name: 'Pause/resume sync',
      callback: () => void this.togglePause(),
    });
    this.addCommand({
      id: 'version-history',
      name: 'Version history for current file',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.engine) return false;
        if (!checking) void this.showHistory(file.path);
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile && this.engine) {
          menu.addItem((item) =>
            item
              .setTitle('Vault Sync: version history')
              .setIcon('history')
              .onClick(() => void this.showHistory(file.path)),
          );
        }
      }),
    );

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

    if (!this.statusBar) {
      this.statusBar = this.addStatusBarItem();
      this.statusBar.addClass('mod-clickable', 'vault-sync-status');
      // Left-click: activity log. Right-click: sync menu.
      this.registerDomEvent(this.statusBar, 'click', () =>
        new ActivityModal(this.app, this.activity).open(),
      );
      this.registerDomEvent(this.statusBar, 'contextmenu', (event) => {
        event.preventDefault();
        const menu = new Menu();
        menu.addItem((item) =>
          item
            .setTitle('Sync now')
            .setIcon('refresh-cw')
            .onClick(() => this.syncNow(true)),
        );
        menu.addItem((item) =>
          item
            .setTitle(this.settings.paused ? 'Resume sync' : 'Pause sync')
            .setIcon(this.settings.paused ? 'play' : 'pause')
            .onClick(() => void this.togglePause()),
        );
        menu.addItem((item) =>
          item
            .setTitle('Sync activity')
            .setIcon('list')
            .onClick(() => new ActivityModal(this.app, this.activity).open()),
        );
        menu.showAtMouseEvent(event);
      });
    }
    this.refreshStatusIcon();

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
      isCategoryExcluded: (path) => isCategoryExcluded(path, this.settings.syncCategories),
      spool: new ChunkSpool(this.app.vault.adapter, `${this.manifest.dir}/spool`),
      log: (message) => this.logActivity(message),
      notify: (message) => {
        new Notice(message);
        this.logActivity(message);
      },
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
    this.registerInterval(window.setInterval(() => void this.syncNow(false), PERIODIC_RESCAN_MS));
    // …app foreground (mobile background→resume never re-runs onload)…
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (!document.hidden) this.scheduleSync();
    });
    // …server push notifications for remote changes…
    this.channel = new ChangeChannel(serverUrl, token, vaultId, (notification) => {
      if (notification.originDeviceId !== this.settings.deviceId) this.scheduleSync();
    });
    this.channel.connect();
    // …and a polling fallback whenever the WebSocket is down.
    this.registerInterval(
      window.setInterval(() => {
        if (!this.channel?.isConnected()) void this.syncNow(false);
      }, POLLING_FALLBACK_MS),
    );

    await this.syncNow(false);
  }

  private scheduleSync(): void {
    if (this.settings.paused) return;
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.syncNow(false);
    }, SYNC_DEBOUNCE_MS);
  }

  async syncNow(interactive = true): Promise<void> {
    if (!this.engine) {
      if (interactive) new Notice('vault-sync: not configured — connect a vault in settings');
      return;
    }
    if (this.settings.paused) {
      if (interactive) new Notice('vault-sync: sync is paused — resume from the status bar menu');
      return;
    }
    this.syncState = 'syncing';
    this.refreshStatusIcon();
    try {
      const changes = await this.engine.requestSync();
      this.syncState = 'idle';
      this.lastSyncAt = new Date();
      this.lastError = null;
      if (interactive) {
        new Notice(changes === 0 ? 'vault-sync: up to date' : `vault-sync: ${changes} change(s) synced`);
      }
    } catch (err) {
      this.syncState = 'error';
      this.lastError = (err as Error).message;
      this.logActivity(`sync failed — ${this.lastError}`);
      new Notice(`vault-sync: sync failed — ${this.lastError}`);
    } finally {
      this.refreshStatusIcon();
    }
  }

  async togglePause(): Promise<void> {
    this.settings.paused = !this.settings.paused;
    await this.saveSettings();
    this.logActivity(this.settings.paused ? 'sync paused' : 'sync resumed');
    new Notice(`vault-sync: ${this.settings.paused ? 'paused' : 'resumed'}`);
    this.refreshStatusIcon();
    if (!this.settings.paused) void this.syncNow(false);
  }

  /** Icon per state; details live in the tooltip. */
  private refreshStatusIcon(): void {
    if (!this.statusBar) return;
    const state = this.settings.paused ? 'paused' : this.syncState;
    const icons = {
      idle: 'check-circle',
      syncing: 'refresh-cw',
      error: 'alert-circle',
      paused: 'pause',
    } as const;
    setIcon(this.statusBar, icons[state]);
    this.statusBar.toggleClass('vault-sync-spin', state === 'syncing');

    const parts = [`Vault Sync: ${state}`];
    if (state === 'syncing' && this.currentDetail) parts.push(this.currentDetail);
    if (state === 'error' && this.lastError) parts.push(this.lastError);
    if (this.lastSyncAt) parts.push(`last sync ${this.lastSyncAt.toLocaleTimeString()}`);
    parts.push(this.channel?.isConnected() ? 'live updates connected' : 'polling (no WebSocket)');
    parts.push('click: activity · right-click: menu');
    const tooltip = parts.join('\n');
    this.statusBar.setAttribute('aria-label', tooltip);
    this.statusBar.setAttribute('data-tooltip-position', 'top');
    this.statusBar.title = tooltip;
  }

  private logActivity(message: string): void {
    console.log(`[vault-sync] ${message}`);
    this.activity.push({ time: new Date().toLocaleTimeString(), message });
    if (this.activity.length > ACTIVITY_LOG_LIMIT) this.activity.shift();
  }

  private async showHistory(path: string): Promise<void> {
    if (!this.engine) return;
    try {
      const revisions = await this.engine.getHistory(path);
      new HistoryModal(this.app, path, revisions, this.settings.deviceId, this.engine).open();
    } catch (err) {
      new Notice(`vault-sync: no history for ${path} — ${(err as Error).message}`);
    }
  }

  /**
   * Live progress: feeds the status-icon tooltip on desktop; on mobile (no
   * status bar) a single persistent Notice updates in place during long
   * transfers.
   */
  private setStatus(message: string | null): void {
    this.currentDetail = message;
    this.refreshStatusIcon();
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
