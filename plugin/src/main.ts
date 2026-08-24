import { Menu, normalizePath, Notice, Plugin, setIcon, TAbstractFile, TFile } from 'obsidian';
import { deriveVaultKeys, getSodium, initSodium } from '@vault-sync/shared';
import { DEFAULT_SETTINGS, VaultSyncSettings, VaultSyncSettingTab } from './settings';
import { RestClient } from './transport/rest';
import { ChangeChannel } from './transport/ws';
import { IndexStore } from './sync/index-store';
import { ChunkSpool } from './sync/spool';
import { SyncEngine } from './sync/engine';
import { VaultScope } from './sync/scope';
import { isUnderAnyMount, stripMount } from './sync/mount-paths';
import { DEFAULT_CATEGORY_TOGGLES, isCategoryExcluded } from './sync/categories';
import { ConfigFs } from './sync/config-fs';
import {
  DEFAULT_CONFIG_SYNC_TOGGLES,
  isConfigExcluded,
  isConfigPath,
} from './sync/config-categories';
import {
  ActivityEntry,
  ActivityModal,
  ConfigHistorySuggestModal,
  ConflictModal,
  ConflictSuggestModal,
  HistoryModal,
  SafetyBrakeModal,
} from './ui/modals';
import { hotApplyConfig, InternalApp } from './sync/hot-apply';
import { ConflictGroup, findConflictGroups } from './sync/conflict-detect';
import { BlockedAction } from './sync/engine';
import { DeleteBurstTracker } from './sync/delete-burst';

const SYNC_DEBOUNCE_MS = 2_000;
const PERIODIC_RESCAN_MS = 5 * 60 * 1000;
// Pull cadence when the WebSocket can't connect (proxies, VPNs, mobile).
const POLLING_FALLBACK_MS = 60 * 1000;
const ACTIVITY_LOG_LIMIT = 200;

/**
 * One sync connection = one server vault: the main whole-vault connection
 * (mountPath null) plus one per folder connection (a shared vault mounted at
 * a local folder). Connections sync strictly sequentially — the per-engine
 * memory guarantees (single large transfer, bounded parallelism) then hold
 * for the whole plugin without cross-engine locks.
 */
interface SyncConnection {
  id: string; // 'main' or FolderConnection.id
  label: string;
  vaultId: string;
  mountPath: string | null;
  engine: SyncEngine;
  channel: ChangeChannel;
}

export default class VaultSyncPlugin extends Plugin {
  settings: VaultSyncSettings = DEFAULT_SETTINGS;
  private connections: SyncConnection[] = [];
  private rest: RestClient | null = null;
  // deviceId → name, fetched lazily for history labels; session-lifetime cache.
  private deviceNames: Map<string, string> | null = null;
  private debounceTimer: number | null = null;
  // Connection ids with pending changes; drained by the debounced sync.
  private pendingSync = new Set<string>();
  private statusBar: HTMLElement | null = null;
  private progressNotice: Notice | null = null;
  private activity: ActivityEntry[] = [];
  private syncState: 'idle' | 'syncing' | 'error' | 'paused' = 'idle';
  private lastSyncAt: Date | null = null;
  private lastError: string | null = null;
  private currentDetail: string | null = null;
  // Conflict siblings currently in the vault; refreshed after each sync and
  // after resolving one via the review modal (see refreshConflicts()).
  private conflictGroups: ConflictGroup[] = [];
  // Actions withheld by a connection's safety brake / delete-burst gate;
  // refreshed after each sync and after a forced sync (see refreshBlocked()).
  private blockedByConnection: {
    connId: string;
    label: string;
    items: readonly BlockedAction[];
  }[] = [];
  // Shared across every connection's engine (see startSync()) — connections
  // sync sequentially, and the failure modes this guards against aren't
  // bounded by mount points.
  private deleteBurst = new DeleteBurstTracker();

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
        if (!file || this.connections.length === 0) return false;
        if (!checking) void this.showHistory(file.path);
        return true;
      },
    });
    // Config files have no TFile, so the file-menu/active-file entry points
    // can't reach them — dedicated picker command instead.
    this.addCommand({
      id: 'settings-history',
      name: 'Version history for a synced settings file',
      checkCallback: (checking) => {
        const paths = this.mainConnection()?.engine.syncedConfigPaths() ?? [];
        if (paths.length === 0) return false;
        if (!checking) {
          new ConfigHistorySuggestModal(
            this.app,
            paths,
            (path) => void this.showHistory(path),
          ).open();
        }
        return true;
      },
    });
    this.addCommand({
      id: 'review-conflict',
      name: 'Review conflict for current file',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const group = file && this.conflictGroups.find((g) => g.original === file.path);
        if (!group) return false;
        if (!checking) this.openConflictReview(group);
        return true;
      },
    });
    this.addCommand({
      id: 'review-conflicts',
      name: 'Review all conflicts',
      checkCallback: (checking) => {
        if (this.conflictGroups.length === 0) return false;
        if (!checking) this.openConflictPicker();
        return true;
      },
    });
    this.addCommand({
      id: 'review-blocked',
      name: 'Review blocked changes',
      checkCallback: (checking) => {
        if (this.blockedByConnection.length === 0) return false;
        if (!checking) this.openBlockedReview();
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile && this.connections.length > 0) {
          const group = this.conflictGroups.find((g) => g.original === file.path);
          if (group) {
            menu.addItem((item) =>
              item
                .setTitle('Vault Sync: review conflict')
                .setIcon('alert-triangle')
                .onClick(() => this.openConflictReview(group)),
            );
          }
          menu.addItem((item) =>
            item
              .setTitle('Vault Sync: version history')
              .setIcon('history')
              .onClick(() => void this.showHistory(file.path)),
          );
        }
      }),
    );

    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (!file || this.connections.length === 0) return;
        // Live per-folder scan (siblings always share the original's
        // folder) rather than the cached this.conflictGroups, so this is
        // accurate even between syncs.
        const folderPaths = (file.parent?.children ?? [])
          .filter((f): f is TFile => f instanceof TFile)
          .map((f) => f.path);
        const group = findConflictGroups(folderPaths).find((g) => g.original === file.path);
        if (group) new Notice(`vault-sync: "${file.name}" has an unreviewed conflict`);
      }),
    );

    // One-time change-source registrations (plugin lifetime — NOT inside
    // startSync, which re-runs on every unlock/connect and would stack
    // duplicate handlers). All of them no-op while connections are empty.
    const onVaultEvent = (file: TAbstractFile, oldPath?: string) => {
      const targets = new Set([this.ownerOf(file.path)]);
      if (typeof oldPath === 'string') targets.add(this.ownerOf(oldPath));
      for (const conn of targets) {
        if (conn && !conn.engine.applyingRemote) this.scheduleSync(conn.id);
      }
    };
    this.registerEvent(this.app.vault.on('create', onVaultEvent));
    this.registerEvent(this.app.vault.on('modify', onVaultEvent));
    this.registerEvent(this.app.vault.on('delete', onVaultEvent));
    this.registerEvent(this.app.vault.on('rename', onVaultEvent));
    // Periodic rescan for external edits Obsidian didn't notice…
    this.registerInterval(window.setInterval(() => void this.syncNow(false), PERIODIC_RESCAN_MS));
    // …app foreground (mobile background→resume never re-runs onload)…
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (!document.hidden) this.scheduleSync();
    });
    // …and a polling fallback for any connection whose WebSocket is down.
    this.registerInterval(
      window.setInterval(() => {
        let anyDown = false;
        for (const conn of this.connections) {
          if (!conn.channel.isConnected()) {
            this.pendingSync.add(conn.id);
            anyDown = true;
          }
        }
        if (anyDown) void this.syncNow(false);
      }, POLLING_FALLBACK_MS),
    );

    if (
      this.settings.token &&
      ((this.settings.vaultId && this.settings.vmkB64) ||
        this.settings.folderConnections.length > 0)
    ) {
      // Sync from a clean layout state; onLayoutReady also covers mobile
      // cold-start-on-foreground (hard rule 2).
      this.app.workspace.onLayoutReady(() => void this.startSync());
    }
  }

  onunload(): void {
    for (const conn of this.connections) conn.channel.disconnect();
  }

  private mainConnection(): SyncConnection | undefined {
    return this.connections.find((c) => c.mountPath === null);
  }

  /** The connection that owns a local path: matching mount, else main. */
  private ownerOf(localPath: string): SyncConnection | undefined {
    return (
      this.connections.find(
        (c) => c.mountPath !== null && isUnderAnyMount(localPath, [c.mountPath]),
      ) ?? this.mainConnection()
    );
  }

  async startSync(): Promise<void> {
    const { serverUrl, token, deviceName } = this.settings;
    if (!serverUrl || !token) return;

    for (const conn of this.connections) conn.channel.disconnect();
    this.connections = [];

    const sodium = getSodium();
    const adapter = this.app.vault.adapter;
    const rest = new RestClient(serverUrl, token);
    this.rest = rest;

    const buildConnection = async (opts: {
      id: string;
      label: string;
      vaultId: string;
      vmkB64: string;
      mountPath: string | null;
    }): Promise<void> => {
      const keys = deriveVaultKeys(
        sodium.from_base64(opts.vmkB64, sodium.base64_variants.ORIGINAL),
      );
      const index = IndexStore.forVault(adapter, this.manifest.dir!, opts.vaultId);
      await index.load();
      const isMain = opts.mountPath === null;
      const configFs = isMain
        ? new ConfigFs(adapter, this.app.vault.configDir, this.manifest.dir!)
        : undefined;
      const scope = new VaultScope({
        vault: this.app.vault,
        mountPath: opts.mountPath ?? '',
        normalizePath,
        configFs,
        getSettingsSyncEnabled: isMain ? () => this.settings.settingsSyncEnabled : undefined,
        getMountPrefixes: isMain
          ? () => this.settings.folderConnections.map((c) => c.localPath)
          : undefined,
      });
      const engine = new SyncEngine({
        scope,
        rest,
        keys,
        vaultId: opts.vaultId,
        deviceName,
        index,
        // Getters, not snapshots: settings changes apply on the very next sync.
        getMaxFileSizeBytes: () => this.settings.maxFileSizeMB * 1024 * 1024,
        getParallelTransfers: () => this.settings.parallelTransfers,
        isCategoryExcluded: (path) =>
          isMain && isConfigPath(path)
            ? isConfigExcluded(
                path,
                this.settings.settingsSyncEnabled,
                this.settings.settingsSyncCategories,
                configFs!.ownPluginCanonicalDir,
              )
            : isCategoryExcluded(path, this.settings.syncCategories),
        spool: new ChunkSpool(adapter, `${this.manifest.dir}/spool/${opts.vaultId}`),
        deleteBurst: this.deleteBurst,
        log: (message) => this.logActivity(isMain ? message : `[${opts.label}] ${message}`),
        notify: (message) => {
          new Notice(message);
          this.logActivity(isMain ? message : `[${opts.label}] ${message}`);
        },
        status: (message) => this.setStatus(message),
        onConfigPulled: isMain
          ? () => hotApplyConfig(this.app as unknown as InternalApp, configFs!)
          : undefined,
      });
      const channel = new ChangeChannel(serverUrl, token, opts.vaultId, (notification) => {
        if (notification.originDeviceId !== this.settings.deviceId) this.scheduleSync(opts.id);
      });
      channel.connect();
      this.connections.push({
        id: opts.id,
        label: opts.label,
        vaultId: opts.vaultId,
        mountPath: opts.mountPath,
        engine,
        channel,
      });
    };

    if (this.settings.vaultId && this.settings.vmkB64) {
      await buildConnection({
        id: 'main',
        label: 'vault',
        vaultId: this.settings.vaultId,
        vmkB64: this.settings.vmkB64,
        mountPath: null,
      });
    }
    for (const fc of this.settings.folderConnections) {
      await buildConnection({
        id: fc.id,
        label: fc.vaultName,
        vaultId: fc.vaultId,
        vmkB64: fc.vmkB64,
        mountPath: fc.localPath,
      });
    }
    await this.sweepStaleSpools();

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
        if (this.blockedByConnection.length > 0) {
          const count = this.blockedByConnection.reduce((n, c) => n + c.items.length, 0);
          menu.addItem((item) =>
            item
              .setTitle(`Review blocked changes (${count})`)
              .setIcon('shield-alert')
              .onClick(() => this.openBlockedReview()),
          );
        }
        if (this.conflictGroups.length > 0) {
          menu.addItem((item) =>
            item
              .setTitle(`Review conflicts (${this.conflictGroups.length})`)
              .setIcon('alert-triangle')
              .onClick(() => this.openConflictPicker()),
          );
        }
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

    await this.syncNow(false);
  }

  /**
   * Spool roots are per-vault (spool/<vaultId>) so engines never GC each
   * other's resumable downloads. Remove children that don't belong to a
   * configured connection — including pre-multi-connection revision dirs at
   * the old flat root. The spool is a disposable download cache.
   */
  private async sweepStaleSpools(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const root = `${this.manifest.dir}/spool`;
    try {
      if (!(await adapter.exists(root))) return;
      const keep = new Set(this.connections.map((c) => c.vaultId));
      const { folders } = await adapter.list(root);
      for (const folder of folders) {
        if (!keep.has(folder.split('/').pop()!)) await adapter.rmdir(folder, true);
      }
    } catch {
      // cache hygiene only — never block startup on it
    }
  }

  private scheduleSync(connectionId?: string): void {
    if (this.settings.paused) return;
    if (connectionId) this.pendingSync.add(connectionId);
    else for (const conn of this.connections) this.pendingSync.add(conn.id);
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.syncNow(false);
    }, SYNC_DEBOUNCE_MS);
  }

  async syncNow(interactive = true): Promise<void> {
    if (this.connections.length === 0) {
      if (interactive) new Notice('vault-sync: not configured — connect a vault in settings');
      return;
    }
    if (this.settings.paused) {
      if (interactive) new Notice('vault-sync: sync is paused — resume from the status bar menu');
      return;
    }
    // Interactive and periodic runs cover everything; the debounced path
    // syncs only the connections with pending changes.
    const ids =
      interactive || this.pendingSync.size === 0
        ? new Set(this.connections.map((c) => c.id))
        : new Set(this.pendingSync);
    this.pendingSync.clear();

    this.syncState = 'syncing';
    this.refreshStatusIcon();
    let changes = 0;
    const errors: string[] = [];
    for (const conn of this.connections) {
      if (!ids.has(conn.id)) continue;
      try {
        changes += await conn.engine.requestSync();
      } catch (err) {
        errors.push(`${conn.label}: ${(err as Error).message}`);
      }
    }
    this.refreshConflicts();
    this.refreshBlocked();
    if (errors.length > 0) {
      this.syncState = 'error';
      this.lastError = errors.join(' · ');
      this.logActivity(`sync failed — ${this.lastError}`);
      new Notice(`vault-sync: sync failed — ${this.lastError}`);
    } else {
      this.syncState = 'idle';
      this.lastSyncAt = new Date();
      this.lastError = null;
      if (interactive) {
        const blockedCount = this.blockedByConnection.reduce((n, c) => n + c.items.length, 0);
        new Notice(
          changes > 0
            ? `vault-sync: ${changes} change(s) synced`
            : blockedCount > 0
              ? `vault-sync: up to date — ${blockedCount} change(s) held back, review from the status bar`
              : 'vault-sync: up to date',
        );
      }
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

  /** Recomputes conflict siblings in the vault and refreshes the status icon. */
  private refreshConflicts(): void {
    this.conflictGroups = findConflictGroups(this.app.vault.getFiles().map((f) => f.path));
    this.refreshStatusIcon();
  }

  /**
   * Recomputes blocked actions from every connection's engine (not just ones
   * synced this round — a debounced pass may have skipped a connection, but
   * its engine still holds its last computed verdict) and refreshes the icon.
   */
  private refreshBlocked(): void {
    this.blockedByConnection = this.connections
      .map((c) => ({ connId: c.id, label: c.label, items: c.engine.blockedActions }))
      .filter((c) => c.items.length > 0);
    this.refreshStatusIcon();
  }

  private openBlockedReview(): void {
    new SafetyBrakeModal(
      this.app,
      this.blockedByConnection,
      (connId) => void this.forceSync(connId),
    ).open();
  }

  private async forceSync(connId: string): Promise<void> {
    const conn = this.connections.find((c) => c.id === connId);
    if (!conn) return;
    if (this.settings.paused) {
      new Notice('vault-sync: resume sync before forcing this through');
      return;
    }
    conn.engine.forceNextSync();
    try {
      await conn.engine.requestSync();
      this.logActivity(`[${conn.label}] forced sync past the safety brake`);
    } catch (err) {
      new Notice(`vault-sync: forced sync failed — ${(err as Error).message}`);
    }
    this.refreshConflicts();
    this.refreshBlocked();
  }

  private openConflictReview(group: ConflictGroup): void {
    if (group.siblings.length === 1) {
      this.showConflict(group.original, group.siblings[0]!);
    } else {
      new ConflictSuggestModal(this.app, group.siblings, (sibling) =>
        this.showConflict(group.original, sibling),
      ).open();
    }
  }

  private openConflictPicker(): void {
    if (this.conflictGroups.length === 1) {
      this.openConflictReview(this.conflictGroups[0]!);
      return;
    }
    new ConflictSuggestModal(
      this.app,
      this.conflictGroups.map((g) => g.original),
      (original) => {
        const group = this.conflictGroups.find((g) => g.original === original);
        if (group) this.openConflictReview(group);
      },
    ).open();
  }

  private showConflict(original: string, sibling: string): void {
    new ConflictModal(this.app, original, sibling, () => this.refreshConflicts()).open();
  }

  /** Icon per state, overlaid with blocked/conflict warnings; details live in the tooltip. */
  private refreshStatusIcon(): void {
    if (!this.statusBar) return;
    const state = this.settings.paused ? 'paused' : this.syncState;
    const icons = {
      idle: 'check-circle',
      syncing: 'refresh-cw',
      error: 'alert-circle',
      paused: 'pause',
    } as const;
    const blockedCount = this.blockedByConnection.reduce((n, c) => n + c.items.length, 0);
    const hasBlocked = blockedCount > 0;
    const hasConflicts = this.conflictGroups.length > 0;
    // Precedence: paused/error win the icon outright; blocked changes (sync
    // actively withholding something) outrank a stale conflict, which
    // otherwise beats the idle/syncing icon (but not the spin — that's only
    // meaningful for the refresh icon itself).
    const icon =
      state === 'paused' || state === 'error'
        ? icons[state]
        : hasBlocked
          ? 'shield-alert'
          : hasConflicts
            ? 'alert-triangle'
            : icons[state];
    setIcon(this.statusBar, icon);
    this.statusBar.toggleClass('vault-sync-spin', icon === icons.syncing);

    const parts = [`Vault Sync: ${state}`];
    if (hasBlocked) {
      parts.push(`${blockedCount} change(s) held back — right-click to review`);
    }
    if (hasConflicts) {
      parts.push(`${this.conflictGroups.length} conflict(s) need review — right-click to open`);
    }
    if (state === 'syncing' && this.currentDetail) parts.push(this.currentDetail);
    if (state === 'error' && this.lastError) parts.push(this.lastError);
    if (this.lastSyncAt) parts.push(`last sync ${this.lastSyncAt.toLocaleTimeString()}`);
    const connected = this.connections.filter((c) => c.channel.isConnected()).length;
    parts.push(
      connected === this.connections.length
        ? 'live updates connected'
        : `polling (${this.connections.length - connected} connection(s) without WebSocket)`,
    );
    if (this.connections.length > 1) {
      parts.push(`${this.connections.length} connections`);
    }
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

  private async showHistory(localPath: string): Promise<void> {
    const conn = this.ownerOf(localPath);
    if (!conn) return;
    const enginePath = conn.mountPath !== null ? stripMount(conn.mountPath, localPath) : localPath;
    if (enginePath === null) return; // the mount folder itself
    try {
      const revisions = await conn.engine.getHistory(enginePath);
      const deviceNames = await this.deviceNamesFor(revisions);
      new HistoryModal(
        this.app,
        enginePath,
        revisions,
        this.settings.deviceId,
        deviceNames,
        conn.engine,
        localPath,
      ).open();
    } catch (err) {
      new Notice(`vault-sync: no history for ${localPath} — ${(err as Error).message}`);
    }
  }

  /**
   * Refetches on a cache miss so devices registered mid-session get names;
   * ids with no device row (revoked) fall back to "unknown device" in the UI.
   * Failure degrades to unlabeled history rather than blocking the modal.
   */
  private async deviceNamesFor(revisions: { deviceId: string }[]): Promise<Map<string, string>> {
    const hasMiss = revisions.some((r) => !this.deviceNames?.has(r.deviceId));
    if (this.rest && (this.deviceNames === null || hasMiss)) {
      try {
        const { devices } = await this.rest.listDevices();
        this.deviceNames = new Map(devices.map((d) => [d.id as string, d.name]));
      } catch {
        this.deviceNames ??= new Map();
      }
    }
    return this.deviceNames ?? new Map();
  }

  /**
   * Live progress: feeds the status-icon tooltip on desktop; on mobile (no
   * status bar) a single persistent Notice updates in place during long
   * transfers. Connections sync sequentially, so one line never interleaves.
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
    const raw = ((await this.loadData()) ?? {}) as Partial<VaultSyncSettings>;
    // Nested toggle objects deep-default: a data.json written before a new
    // toggle key existed must not leave it undefined (undefined reads as
    // "toggle off" in the exclusion predicates — silent exclusion).
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...raw,
      syncCategories: { ...DEFAULT_CATEGORY_TOGGLES, ...raw.syncCategories },
      settingsSyncCategories: { ...DEFAULT_CONFIG_SYNC_TOGGLES, ...raw.settingsSyncCategories },
      folderConnections: raw.folderConnections ?? [],
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
