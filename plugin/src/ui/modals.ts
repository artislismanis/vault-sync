import { App, FuzzySuggestModal, Modal, Notice, Setting } from 'obsidian';
import { rewrapVmk, unwrapVmk, VaultSummary, WrongPassphraseError } from '@vault-sync/shared';
import type { Revision } from '@vault-sync/shared';
import type { BlockedAction, SyncEngine } from '../sync/engine';
import { RestClient } from '../transport/rest';
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
        const button = tabs.createEl('button', { text: label, cls: 'vault-sync-history-tab' });
        button.disabled = !enabled;
        button.toggleClass('is-active', this.view === key);
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

/**
 * Diff a conflict sibling against the note it shadows. Unlike HistoryModal,
 * both sides are already plain local files (conflictFile()/mergeHeads() both
 * write through writeLocal() before any UI sees them) — no decrypt, no
 * network, no engine-domain path translation.
 */
export class ConflictModal extends Modal {
  constructor(
    app: App,
    private original: string,
    private sibling: string,
    /** Called after "Delete conflict copy" so the caller can refresh state. */
    private onResolved: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('vault-sync-history-modal');
    void this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: `Conflict — ${this.original}` });
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: `"${this.original}" was kept; "${this.sibling}" is the local copy from before the conflict.`,
    });

    const originalFile = this.app.vault.getFileByPath(this.original);
    const siblingFile = this.app.vault.getFileByPath(this.sibling);
    if (!originalFile || !siblingFile) {
      contentEl.createEl('p', { text: 'One of these files no longer exists.' });
    } else if (
      !isMergeableText(this.original) ||
      originalFile.stat.size > PREVIEW_MAX_BYTES ||
      siblingFile.stat.size > PREVIEW_MAX_BYTES
    ) {
      contentEl.createEl('p', {
        text: isMergeableText(this.original)
          ? 'File is too large to preview here.'
          : 'Preview is only available for text notes.',
        cls: 'setting-item-description',
      });
    } else {
      const pane = contentEl.createDiv({ cls: 'vault-sync-history-pane' });
      pane.setText('Loading…');
      const [siblingText, originalText] = await Promise.all([
        this.app.vault.read(siblingFile),
        this.app.vault.read(originalFile),
      ]);
      pane.empty();
      if (!isDiffable(siblingText, originalText)) {
        pane.setText('Too many lines to diff.');
      } else {
        const diff = lineDiff(siblingText, originalText);
        if (!hasChanges(diff)) {
          pane.setText('Identical — safe to delete the conflict copy.');
        } else {
          for (const line of diff) {
            pane.createEl('div', { text: line.text || ' ', cls: `vault-sync-diff-${line.kind}` });
          }
        }
      }
    }

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText('Delete conflict copy')
          .setWarning()
          .onClick(async () => {
            if (!siblingFile) return;
            await this.app.vault.trash(siblingFile, false);
            new Notice(`vault-sync: "${this.sibling}" moved to .trash`);
            this.onResolved();
            this.close();
          }),
      )
      .addButton((button) => button.setButtonText('Close').onClick(() => this.close()));
  }
}

/**
 * Picker for a conflict group with more than one sibling, or the vault-wide
 * list of conflicted notes ("Review all conflicts"). Same FuzzySuggestModal
 * pattern as ConfigHistorySuggestModal.
 */
export class ConflictSuggestModal extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private items: string[],
    private onChoose: (path: string) => void,
  ) {
    super(app);
    this.setPlaceholder('Pick a conflicted file…');
  }

  getItems(): string[] {
    return this.items;
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    this.onChoose(item);
  }
}

const BLOCKED_ACTION_VERB: Record<BlockedAction['kind'], string> = {
  pushDelete: 'Delete on the server (prior version stays in history)',
  deleteLocal: 'Delete locally (moved to .trash)',
  pull: 'Overwrite the local file from the server',
};

/**
 * Lists everything the safety brake and/or delete-burst gate are currently
 * withholding, across every connection at once (rare enough that the whole
 * picture matters together, unlike conflicts). Force bypasses both gates for
 * one sync — same two-step inline confirm as HistoryModal's restore and
 * EditVaultModal's delete, since it deserves the same ceremony.
 */
export class SafetyBrakeModal extends Modal {
  constructor(
    app: App,
    private connections: { connId: string; label: string; items: readonly BlockedAction[] }[],
    private onForce: (connId: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('vault-sync-history-modal');
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Sync paused — changes withheld' });
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'These changes were withheld rather than executed, in case they came from a bad ' +
        'scan rather than real intent. Nothing has been lost — review below, then force the ' +
        'sync if this is expected.',
    });

    for (const conn of this.connections) {
      contentEl.createEl('h4', { text: `${conn.label} (${conn.items.length})` });
      const list = contentEl.createDiv({ cls: 'vault-sync-history-pane' });
      for (const item of conn.items) {
        const suffix = item.reason === 'burst' ? ' (delete burst)' : '';
        list.createEl('div', {
          text: `${BLOCKED_ACTION_VERB[item.kind]}: ${item.localPath}${suffix}`,
        });
      }
      this.renderForce(contentEl, conn.connId, conn.label);
    }
  }

  private renderForce(containerEl: HTMLElement, connId: string, label: string): void {
    const force = new Setting(containerEl);
    force.addButton((button) =>
      button
        .setButtonText(`Force sync "${label}"`)
        .setWarning()
        .onClick(() => {
          force.clear();
          force.setName(`Push all withheld changes for "${label}" through?`);
          force.setDesc('Bypasses both safety checks for this one sync.');
          force.addButton((confirm) =>
            confirm
              .setButtonText('Force sync')
              .setWarning()
              .onClick(() => {
                this.onForce(connId);
                this.close();
              }),
          );
          force.addButton((cancel) =>
            cancel.setButtonText('Cancel').onClick(() => {
              force.settingEl.remove();
              this.renderForce(containerEl, connId, label);
            }),
          );
        }),
    );
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

export interface EditVaultModalCallbacks {
  /** Applied to the connected vault after a successful rename. */
  onRenamed: (newName: string) => void | Promise<void>;
  /** VMK is unchanged by a passphrase change — nothing local to update. */
  onPassphraseChanged: () => void | Promise<void>;
  /** Clears the local connection and any cached sync state for this vault. */
  onDeleted: () => void | Promise<void>;
}

/**
 * Rename / change passphrase / delete for the connected vault — one click
 * off the "Connected to X" row (docs/decisions.md: follows Obsidian Sync's
 * layout instead of a standalone "Manage vault" section). Rename and delete
 * are gated on the vault passphrase where crypto still requires it (delete —
 * "prove you hold the key"); rename itself no longer needs it now that names
 * are server-visible plaintext.
 */
export class EditVaultModal extends Modal {
  constructor(
    app: App,
    private vaultId: string,
    private vaultName: string,
    private serverUrl: string,
    private token: string | null,
    /** Live lookup — the settings tab's vault list may refresh while this is open. */
    private getSummary: () => VaultSummary | undefined,
    private callbacks: EditVaultModalCallbacks,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private rest(): RestClient {
    return new RestClient(this.serverUrl, this.token);
  }

  private requireSummary(): VaultSummary | null {
    const s = this.getSummary();
    if (!s) {
      new Notice('vault-sync: refresh the vault list first, then reopen this dialog');
      return null;
    }
    return s;
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: `Edit "${this.vaultName}"` });
    this.renderRename(contentEl);
    this.renderChangePassphrase(contentEl);
    this.renderDelete(contentEl);
  }

  private renderRename(containerEl: HTMLElement): void {
    let newName = '';
    const rename = new Setting(containerEl).setName('Rename vault');
    rename.addText((text) => text.setPlaceholder('new name').onChange((v) => (newName = v)));
    rename.addButton((button) =>
      button.setButtonText('Rename').onClick(async () => {
        if (!newName) {
          new Notice('vault-sync: enter a new name');
          return;
        }
        try {
          await this.rest().updateVault(this.vaultId, { name: newName });
          this.vaultName = newName;
          await this.callbacks.onRenamed(newName);
          new Notice(`vault-sync: renamed to "${newName}"`);
          this.render();
        } catch (err) {
          new Notice(`vault-sync: ${(err as Error).message}`);
        }
      }),
    );
  }

  private renderChangePassphrase(containerEl: HTMLElement): void {
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
        const s = this.requireSummary();
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
          await this.rest().updateVault(this.vaultId, {
            kdf: envelope.kdf,
            wrappedVmkB64: envelope.wrappedVmkB64,
          });
          // VMK unchanged: the cached key and live connection keep working.
          new Notice('vault-sync: passphrase changed');
          await this.callbacks.onPassphraseChanged();
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

  /** Passphrase + typed confirmation, then a two-step inline confirm. Irreversible. */
  private renderDelete(containerEl: HTMLElement): void {
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
          const s = this.requireSummary();
          if (!s) return;
          const confirmMatches =
            typed === this.vaultName || typed.trim().toLowerCase() === 'delete';
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
          del.clear();
          del.setName(`Permanently delete "${this.vaultName}"?`);
          del.setDesc('This cannot be undone.');
          del.addButton((confirm) =>
            confirm
              .setButtonText('Delete forever')
              .setWarning()
              .onClick(async () => {
                confirm.setDisabled(true);
                try {
                  await this.rest().deleteVault(this.vaultId);
                  new Notice(`vault-sync: deleted "${this.vaultName}"`);
                  await this.callbacks.onDeleted();
                  this.close();
                } catch (err) {
                  new Notice(`vault-sync: ${(err as Error).message}`);
                  confirm.setDisabled(false);
                }
              }),
          );
          del.addButton((cancel) => cancel.setButtonText('Cancel').onClick(() => this.render()));
        }),
    );
  }
}
