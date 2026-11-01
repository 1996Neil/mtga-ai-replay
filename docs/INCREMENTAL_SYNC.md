# Incremental replay sync and local retention

Implementation contract (2026-10-30):

- The sync button compares the published index and local replay revisions. It
  never imports raw logs. Local ingestion runs independently in a worker.
  The desktop entry point starts sync and collection updates only on explicit
  clicks. Refresh resumes status observation silently and never opens old
  result panels. Clicking a completed task's primary button starts a new task.
- Log ingestion remembers byte offsets and JSON framing across appends and
  restarts. Only affected matches are rebuilt; truncation/rotation resets the
  corresponding cursor. Existing account, tutorial and visibility rules apply.
- Local retention is optional (unlimited until configured), based on match
  start time and rolling 24-hour days. Older records are neither uploaded nor
  downloaded, and are removed from the local archive/outbox. Cloud data and
  explicit user deletion tombstones are separate from local eviction.
- Settings show a preview before saving. Saving applies cleanup and reclaims
  SQLite disk space. Original Arena logs and cloud Git history are not deleted.
  Sparse checkout removes expired match files without cloud deletions.
  Compressed Git history remains a separate transport cache.
- No new dependencies. Preserve unrelated collection changes. Verify only
  changed ingestion, sync, retention, API and settings behavior plus Viewer build.
- Risks to review: in-flight work racing cleanup, reimport after eviction,
  offline retry, remote/local version conflicts, malformed settings, rotation,
  partial UTF-8/JSON, disk reclamation, and cloud deletion propagation.

References: Elastic Filebeat's persistent file registry / read position;
Syncthing's metadata-based scanning; SQLite VACUUM for file-space reclamation.
These are design references, not copied code or new runtime dependencies.

- https://www.elastic.co/docs/reference/beats/filebeat/reduce-registry-size
- https://docs.syncthing.net/users/syncing
- https://sqlite.org/lang_vacuum.html

Current behavior:

- An unchanged explicit sync queries the private repository's default-branch
  commit once. Matching branch + commit permits reuse of the index for that
  exact revision. A changed commit uses the existing fetch/publisher path.
- Both-side edits are reported as conflicts before any publication. A second
  comparison protects the gap before publishing. Download receipts bind the
  exact archive transaction revision, not a later readback.
- Ingestion and sync overlap without blocking the button on parsing. Retention
  cleanup is exclusive. SQLite writes are short transactions; replacement uses
  a revision comparison. The desktop Replay launcher enables automatic-sync mode:
  a successful local import queues a separate asynchronous remote publication,
  while the local archive remains immediately readable. The
  optional automatic-sync mode remains available to other callers, and the
  desktop entry point enables it.
- Settings remain unlimited until the user saves a policy. Cleanup runs when
  saved and at most daily during later startup/hourly checks. It never creates a
  remote deletion. Git sparse checkout removes expired working files while
  keeping compressed transport history. Recovery refs preserve unpublished
  generated commits if expired work must be removed from the outgoing branch.
- Changing to a longer retention window makes older cloud records eligible for
  download on the next explicit sync. Existing user deletion tombstones remain
  authoritative.

Verification (2026-10-30, Asia/Shanghai):

- Focused ingestion/retention/sync/API, history, server, task journal and delta
  checks passed. Added regressions cover partial UTF-8/JSON, same-inode
  truncation, cloud-only download, existing remote updates, simultaneous edits,
  sparse cleanup + later upload, failed outgoing push + expiry, and a match
  arriving during an active sync. No full suite was run.
- Viewer TypeScript/build passed. Browser exercise saved and cleaned synthetic
  data, closed with Escape, and found no script errors or dialog horizontal
  overflow at 375px. Production retention remains unlimited.
- Live archive/published index: 231 matches; no pending uploads. Real unchanged
  remote checks with lightweight probing: 2100 ms and 2154 ms. These are not
  measurements of a new replay payload upload. The previous 414132 ms task
  included 27 new replays and the old scanning workflow, so it is not a like-for-like
  speed ratio.
- Independent review found no blocking issue in the core changes. Concurrent
  draft UI work and existing collection changes are outside this task.
