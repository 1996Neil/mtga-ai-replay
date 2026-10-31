# Git-first incremental sync

> Historical CLI workflow. Since 2026-10-30 the default Viewer uses independent
> local ingestion and bidirectional sync instead. See
> [INCREMENTAL_SYNC.md](INCREMENTAL_SYNC.md) for the current button and retention
> settings. The implementation below remains available to legacy callers.

New replays are parsed into `replay-outbox/replays.sqlite3`, a durable local
transmission queue that is not the Viewer archive. The publisher uses the
configured private repository and canonical exclusions. Only the exact snapshot
whose content hash and stable history key are confirmed in the freshly verified
remote index is promoted to the Viewer archive. Upload failures leave it queued.
Concurrent background and button requests share one pipeline.

Draft observations likewise remain queued until Git readback succeeds. The
Viewer projects only observation IDs listed in the confirmed publication receipt.
Existing archived matches remain visible.

Normal sync trusts the configured personal repository and existing history.
It does not enumerate historical commits or read old replay blobs. New/changed
outgoing files retain path, format, credential and byte-integrity checks.
Git performs its normal missing-object negotiation and non-force push; the exact
remote publication is confirmed before local promotion.

If the local input attributes and transmission queue are unchanged, the button
returns immediately using the local published receipt. It does not contact GitHub
and does not claim to have freshly inspected remote changes. This is an upload
workflow, not an automatic remote-history downloader.

`npm run sync:audit` performs the original full-history audit explicitly.

References consulted: Git's `git-push` documentation (only necessary missing
remote data is sent) and Syncthing's synchronization/scanning documentation
(modification time, size and permissions gate rehashing).

Official references:

- https://git-scm.com/docs/git-push
- https://docs.syncthing.net/users/syncing
