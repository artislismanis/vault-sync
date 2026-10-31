import type { DiffLine } from '../merge/linediff';
import { addInlineMarks, splitByMarks } from '../merge/inlinediff';

/**
 * Renders a line diff into `pane`, one `.vault-sync-diff-<kind>` row per line.
 * Paired changed lines get `.vault-sync-diff-mark` spans around the characters
 * that differ; every other line renders exactly as plain text.
 */
export function renderDiffLines(pane: HTMLElement, diff: DiffLine[]): void {
  for (const line of addInlineMarks(diff)) {
    const row = pane.createDiv({ cls: `vault-sync-diff-${line.kind}` });
    if (!line.marks) {
      row.setText(line.text || ' ');
      continue;
    }
    for (const part of splitByMarks(line.text, line.marks)) {
      if (part.changed) row.createSpan({ cls: 'vault-sync-diff-mark', text: part.text });
      else row.appendText(part.text);
    }
  }
}
