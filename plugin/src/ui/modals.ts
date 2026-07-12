import { App, FuzzySuggestModal, Modal, Notice, Setting } from 'obsidian';
import type { Revision } from '@vault-sync/shared';
import type { SyncEngine } from '../sync/engine';
import { isMergeableText } from '../sync/index-store';
import { hasChanges, isDiffable, lineDiff } from '../merge/linediff';
import { deviceLabel, formatBytes, formatRelativeWhen, formatWhen } from './format';

// Preview/diff decrypt whole revisions into webview memory; cap what the
// history UI will fetch (mobile OOM guard — same ceiling as the merge base
// cache).
const PREVIEW_MAX_BYTES = 1024 * 1024;

type DetailView = 'preview' | 'current' | 'previous';

export class HistoryModal extends Modal {
  private selected: Revision | null = null;
  private view: DetailView = 'current';
  // Decrypted text per revision id, for the modal's lifetime.
  private textCache = new Map<string, string>();
  // Monotonic token: a stale decrypt resolving late must not clobber the pane.
  private loadToken = 0;

  constructor(
    app: App,
    /** Engine-domain path — what getHistory/restore/preview operate on. */
    private path: string,
    private revisions: Revision[],
    private ownDeviceId: string | null,
    private deviceNames: Map<string, string>,
    private engine: SyncEngine,
    /** Local vault path shown to the user; differs for mounted folders. */
    private displayPath: string = path,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('vault-sync-history-modal');
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
    this.textCache.clear();
  }

  private render(): void {
    this.loadToken++;
    this.contentEl.empty();
    if (this.selected) {
      this.renderDetail(this.selected);
    } else {
      this.renderList();
    }
  }

  private device(revision: Revision): string {
    return deviceLabel(revision.deviceId, this.ownDeviceId, this.deviceNames);
  }

  // --- list view -----------------------------------------------------------

  private renderList(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: `History — ${this.displayPath}` });
    contentEl.createEl('p', {
      text: 'Select a version to preview it and see what changed. Restoring writes the old content as a new revision — nothing is ever overwritten in history.',
      cls: 'setting-item-description',
    });

    this.revisions.forEach((revision, i) => {
      const what = revision.deleted ? 'deleted' : formatBytes(revision.sizeBytes);
      const latest = i === 0 ? ' · latest' : '';
      const label = `${formatRelativeWhen(revision.serverReceivedAt)} · ${what} · ${this.device(revision)}${latest}`;
      const setting = new Setting(contentEl).setName(label);
      setting.nameEl.title = formatWhen(revision.serverReceivedAt);
      if (!revision.deleted) {
        setting.addButton((button) =>
          button.setButtonText('View').onClick(() => {
            this.selected = revision;
            this.view = 'current';
            this.render();
          }),
        );
      }
    });
  }

  // --- detail view ---------------------------------------------------------

  private renderDetail(revision: Revision): void {
    const { contentEl } = this;

    const back = contentEl.createEl('a', { text: '← All versions' });
    back.addEventListener('click', (event) => {
      event.preventDefault();
      this.selected = null;
      this.render();
    });

    contentEl.createEl('h3', {
      text: `${formatWhen(revision.serverReceivedAt)} · ${formatBytes(revision.sizeBytes)} · ${this.device(revision)}`,
    });

    const textEligible = isMergeableText(this.path) && revision.sizeBytes <= PREVIEW_MAX_BYTES;

    if (textEligible) {
      const tabs = contentEl.createDiv({ cls: 'vault-sync-history-tabs' });
      const pane = contentEl.createDiv({ cls: 'vault-sync-history-pane' });
      const previous = this.previousOf(revision);
      const views: { key: DetailView; label: string; enabled: boolean }[] = [
        { key: 'preview', label: 'Preview', enabled: true },
        { key: 'current', label: 'Diff vs current', enabled: this.currentFileExists() },
        { key: 'previous', label: 'Diff vs previous', enabled: previous !== null },
      ];
      if (!views.find((v) => v.key === this.view)?.enabled) this.view = 'preview';
      for (const { key, label, enabled } of views) {
        const button = tabs.createEl('button', { text: label });
        button.disabled = !enabled;
        button.toggleClass('mod-cta', this.view === key);
        button.addEventListener('click', () => {
          this.view = key;
          this.render();
        });
      }
      void this.loadPane(pane, revision, previous);
    } else {
      const why =
        revision.sizeBytes > PREVIEW_MAX_BYTES
          ? 'File is too large to preview here.'
          : 'Preview is only available for text notes.';
      contentEl.createEl('p', { text: why, cls: 'setting-item-description' });
      const meta = contentEl.createDiv({ cls: 'vault-sync-history-pane' });
      meta.createEl('div', { text: `Size: ${formatBytes(revision.sizeBytes)}` });
      meta.createEl('div', { text: `Device: ${this.device(revision)}` });
      meta.createEl('div', { text: `Edited: ${formatWhen(revision.clientMtime)}` });
      meta.createEl('div', { text: `Synced: ${formatWhen(revision.serverReceivedAt)}` });
      if (revision.chunks != null) meta.createEl('div', { text: `Chunks: ${revision.chunks}` });
    }

    this.renderRestore(contentEl, revision);
  }

  /** Nearest older content revision (tombstones have nothing to diff against). */
  private previousOf(revision: Revision): Revision | null {
    const at = this.revisions.indexOf(revision);
    return this.revisions.slice(at + 1).find((r) => !r.deleted) ?? null;
  }

  private currentFileExists(): boolean {
    return this.app.vault.getFileByPath(this.displayPath) !== null;
  }

  private async loadPane(
    pane: HTMLElement,
    revision: Revision,
    previous: Revision | null,
  ): Promise<void> {
    const token = this.loadToken;
    pane.setText('Decrypting…');
    try {
      const text = await this.revisionText(revision);
      let oldText: string | null = null;
      if (this.view === 'current') {
        const file = this.app.vault.getFileByPath(this.displayPath);
        oldText = file ? await this.app.vault.read(file) : null;
      } else if (this.view === 'previous' && previous) {
        oldText = await this.revisionText(previous);
      }
      if (token !== this.loadToken) return;

      pane.empty();
      if (this.view === 'preview' || oldText === null) {
        pane.setText(text);
        return;
      }
      if (!isDiffable(oldText, text)) {
        pane.setText('Too many lines to diff — use Preview instead.');
        return;
      }
      // Selected revision is always the "new" side: additions are what
      // restoring would bring in, deletions what it would remove.
      const diff = lineDiff(oldText, text);
      if (!hasChanges(diff)) {
        pane.setText(
          this.view === 'current'
            ? 'Identical to the current file.'
            : 'Identical to the previous version.',
        );
        return;
      }
      for (const line of diff) {
        pane.createEl('div', {
          text: line.text || ' ',
          cls: `vault-sync-diff-${line.kind}`,
        });
      }
    } catch (err) {
      if (token === this.loadToken) pane.setText(`Failed to load — ${(err as Error).message}`);
    }
  }

  private async revisionText(revision: Revision): Promise<string> {
    const cached = this.textCache.get(revision.id);
    if (cached !== undefined) return cached;
    const text = new TextDecoder().decode(await this.engine.readRevisionContent(revision));
    this.textCache.set(revision.id, text);
    return text;
  }

  private renderRestore(containerEl: HTMLElement, revision: Revision): void {
    const restore = new Setting(containerEl);
    restore.addButton((button) =>
      button.setButtonText('Restore this version').onClick(() => {
        restore.clear();
        restore.setName('Write this content over the current file?');
        restore.setDesc('The current version stays in history.');
        restore.addButton((confirm) =>
          confirm
            .setButtonText('Restore')
            .setCta()
            .onClick(async () => {
              confirm.setDisabled(true);
              try {
                await this.engine.restoreRevision(this.path, revision);
                new Notice(`vault-sync: restored ${this.displayPath}`);
                this.close();
              } catch (err) {
                new Notice(`vault-sync: restore failed — ${(err as Error).message}`);
                confirm.setDisabled(false);
              }
            }),
        );
        restore.addButton((cancel) =>
          cancel.setButtonText('Cancel').onClick(() => {
            restore.settingEl.remove();
            this.renderRestore(containerEl, revision);
          }),
        );
      }),
    );
  }
}

/**
 * Picker for synced .obsidian files — they have no TFile, so the regular
 * file-menu/active-file history entry points can't reach them.
 */
export class ConfigHistorySuggestModal extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private paths: string[],
    private onChoose: (path: string) => void,
  ) {
    super(app);
    this.setPlaceholder('Pick a settings file…');
  }

  getItems(): string[] {
    return this.paths;
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    this.onChoose(item);
  }
}

export interface ActivityEntry {
  time: string;
  message: string;
}

export class ActivityModal extends Modal {
  constructor(
    app: App,
    private entries: ActivityEntry[],
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Sync activity' });
    if (this.entries.length === 0) {
      contentEl.createEl('p', { text: 'No activity this session.' });
      return;
    }
    const list = contentEl.createEl('div');
    list.style.fontFamily = 'var(--font-monospace)';
    list.style.fontSize = 'var(--font-smallest)';
    list.style.maxHeight = '60vh';
    list.style.overflowY = 'auto';
    for (const entry of [...this.entries].reverse()) {
      list.createEl('div', { text: `${entry.time}  ${entry.message}` });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
