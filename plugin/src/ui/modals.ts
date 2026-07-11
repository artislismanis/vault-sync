import { App, Modal, Notice, Setting } from 'obsidian';
import type { Revision } from '@vault-sync/shared';
import type { SyncEngine } from '../sync/engine';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString();
}

export class HistoryModal extends Modal {
  constructor(
    app: App,
    private path: string,
    private revisions: Revision[],
    private ownDeviceId: string | null,
    private engine: SyncEngine,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: `History — ${this.path}` });
    contentEl.createEl('p', {
      text: 'Restoring writes the old content as a new revision — nothing is ever overwritten in history.',
      cls: 'setting-item-description',
    });

    for (const revision of this.revisions) {
      const own = revision.deviceId === this.ownDeviceId ? ' · this device' : '';
      const label = revision.deleted
        ? `${formatWhen(revision.serverReceivedAt)} · deleted${own}`
        : `${formatWhen(revision.serverReceivedAt)} · ${formatBytes(revision.sizeBytes)}${own}`;
      const setting = new Setting(contentEl).setName(label);
      if (!revision.deleted) {
        setting.addButton((button) =>
          button.setButtonText('Restore').onClick(async () => {
            try {
              await this.engine.restoreRevision(this.path, revision);
              new Notice(`vault-sync: restored ${this.path}`);
              this.close();
            } catch (err) {
              new Notice(`vault-sync: restore failed — ${(err as Error).message}`);
            }
          }),
        );
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
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
