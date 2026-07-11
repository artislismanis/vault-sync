// Sync engine — the orchestrator. Not implemented yet; the contract below is
// fixed by docs/sync-protocol.md.
//
// Responsibilities:
// - reconcile(): full local-scan vs sync-index vs server-heads comparison.
//   Runs on connect, on mobile foreground, and periodically on desktop.
//   External edits (Claude Code, OS file drops) are detected HERE, never
//   assumed to arrive via vault events (CLAUDE.md hard rule 3).
// - pull: fetch unseen revisions → decrypt → apply, or divert to merge.
// - push: encrypt → upload with parent revision id; server never rejects on
//   conflict — concurrent heads live in the DAG and are resolved client-side.
// - delete: tombstones; history retains prior content (hard rule 4).

export {};
