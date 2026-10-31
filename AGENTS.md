# Runtime cost

- Keep normal operation incremental. Idle polls inspect small revision metadata only.
- Reuse unchanged catalogs, immutable blobs and already published match proofs.
- Read or rebuild detailed history only for changed records. First-time indexing and
  explicit repair/audit are separate paths, never silent background defaults.
- Validate changed data at its write/publish boundary; do not repeatedly validate
  the same unchanged snapshot in every layer.
- Keep tasks single-flight and caches bounded. Do not add workers, timers, network
  checks or dependencies without a measured need.
- Performance changes must retain account isolation and atomic writes. Verify
  work counts for idle, one-record change and retry, not just test duration.

# Verification cost

- Default to the smallest affected test set and a small regression fixture.
  Expand only for a concrete failure or a changed shared contract; do not rerun
  passing checks without new evidence.
- Full suites, full-corpus replay rebuilds and release/history audits are
  explicit separate workflows, never startup, polling or ordinary replay reads.
- Verify idle, one-record change and retry with bounded synthetic work counts;
  do not scan the user's whole archive to prove a local change.

# UI scope

- Replay is a desktop application. Keep one desktop layout; do not add mobile
  breakpoints, phone-only controls, bottom navigation or safe-area padding.
- Preserve desktop window scrolling, popup bounds and reduced-motion support.
