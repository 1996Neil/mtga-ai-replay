# Automatic completed-match upload: source-only first slice

## Scope and activation

This change adds an opt-in controller around the existing sanitized Coach Bundle
publisher. It does not enable a running installation, alter a repository binding,
change a launcher, install a background service, create a model request, or expose
an HTTP activation endpoint. Existing CLI and Replay 2.0 entrypoints remain OFF.

A separately reviewed local activation can pass `autoUploadOptions` to
`startReplayServer`, including `enabled: true` and a bounded `binding`:

- `repository`: the deliberately configured private `owner/name`
- `repository_id`: the immutable GitHub GraphQL repository ID returned by
  `gh repo view --json id`; this is not a guessed name or an unconverted REST
  numeric repository ID
- `branch`: the approved default branch

Both local log observation and replay-sync capability are required. The first
successful local import establishes a durable consent/archive baseline before any
network operation, even offline. Remote readiness is stored separately; new games
played offline remain queued after reconnection. Remote preflight checks the
current private repository, stable ID, name,
branch, checkout/history safety, pending ownership and outgoing commits. A
rename, transfer, repository recreation or branch change blocks the old binding;
this slice does not perform a rebind or migration.

The baseline is never uploaded automatically. A completed match must have a
stable ID, known Win/Loss/Draw result, detailed steps and a start time at or after
explicit activation. This also excludes old rotated logs discovered later and
matches already in progress when activation occurred. BO1 is one game per match.
BO3 uploads only after the completed match reaches the canonical archive; it does
not publish an incomplete match after game one. Readiness additionally requires
explicit completed-match evidence, the declared expected game count, every
corresponding game number and an observed GameOver terminal GRE for each game.
A MatchCompleted record or a quiet polling interval alone is insufficient.
Unfinalized new matches remain visible as `waiting_source`.

The parser records this local-only evidence without changing action/state
reconstruction or the cloud bundle schema. A tightly bounded archive enrichment
accepts an explicit terminal-evidence false-to-true transition: only its exact
derived terminal warning may disappear, and the named parser counters may only
increase. Existing state/action/timeline/result preservation checks remain in
force. Legacy missing evidence, changed known facts, fewer counters and unrelated
warning removal still conflict and require manual review. This does not refresh
already uploaded automatic rows or rewrite remote history.

## Durable workflow

The controller reads only the canonical local replay archive. Its local SQLite
ledger holds match IDs, times, bounded states, immutable bundle references and
verified commit receipts. It holds no replay payload, raw log or credential.
Observation and queue insertion happen in the same local transaction, so a crash
cannot advance a completion cursor without retaining the corresponding work.
The ledger uses WAL/FULL synchronization, private permissions and an exclusive
live-owner claim. Unknown or reused owner PIDs fail closed.

`waiting_source -> queued -> preparing -> prepared -> publishing -> succeeded`

Only `succeeded` means independently fetched remote bytes matched the exact
validated local bundle. Bundle generation runs through the same card/bundle
sanitizer and queue as manual synchronization. Once prepared, the exact bytes and
hash are retained across retries; they are not regenerated over an uncertain
pending upload. An existing same-match pending bundle without this queue row's
own immutable preparation receipt is blocked rather than adopted or overwritten,
including an interrupted preparation that never persisted its receipt. Enqueue
rechecks that condition under the publisher lock. Publication also compares the
exact match/start/key/hash receipt under that lock, so another process cannot
replace the bundle between preparation and upload. The automatic publisher
refuses unrelated pending matches and
previously outgoing local commits. A prepared receipt owns the lane through its
retry deadline, even when an older waiting-source match finalizes later. The
existing namespace, history, visibility,
remote, service-identity and content guards still apply.

Default polling is 30 seconds. Definite pre-write network/busy failures use
exponential retry delays from 30 seconds to 15 minutes. No raw source file is
uploaded. The existing optional public card metadata lookup is unchanged; no paid
AI, TTS or collection path is invoked by the queue.

## Unknown writes and recovery

The publishing marker is durable before calling the publisher; a scanned commit
checkpoint is durable before its network write. A restart during publication, a
lost push response or an inconclusive confirmation becomes `needs_recovery`.
The controller does not push again. It performs bounded read-only reconciliation
against the exact retained bundle and checks the remote index, manifest and every
expected core/part byte from a fetched revision. An unrelated later remote commit
does not invalidate an otherwise identical receipt. Successful reconciliation
removes only the matching local pending reference under the existing sync lock,
then persists the verified queue receipt. These are separate durable writes; a
crash between them repeats read-only verification, never publication. Bundle
files and the replay archive are retained.

If the remote outcome remains absent or uncertain, new automatic writes remain
blocked. Security, scope and binding errors require explicit local review; this
slice does not add a force-retry, discard, automatic lock removal, cleanup or
rebind endpoint. It does not claim local archive space can be reclaimed yet.

## Manual coexistence and server lifecycle

The manual upload button retains its explicit full-history behavior. In the
running server, manual replay/collection jobs and automatic publication share a
single mutation lane, in addition to the publisher's existing cross-process
lock. A manual receipt can satisfy a queued automatic completion without another
upload. A durable unverified automatic write blocks manual mutations even when
automatic mode is disabled, so disabling the feature cannot become a blind retry.
The existing manual task journal and reconciliation behavior are unchanged.

`GET /api/auto-upload` is read-only status. It exposes counts and bounded status,
not paths, credentials, raw errors or payloads. POST cannot enable the feature.
Shutdown waits for an active automatic publication and preserves queued work.

## Test coverage and limits

Offline tests cover default OFF/no ledger, first-activation offline/restart with
a durable consent baseline, historical backlog exclusion,
late-discovered historical logs, incomplete matches, duplicate completion,
concurrent ticks, offline/restart, immutable prepared receipts, interrupted
publication, absent remote outcomes, bounded reconciliation, manual coexistence,
live-owner/binding guards, private journal permissions and HTTP activation/lane
boundaries. Local bare-Git integration covers the real validated publisher,
repository-ID changes, unrelated pending/outgoing scope, exact remote bytes after
HEAD advances, lost acknowledgement reconciliation and uncertain rejected writes.
All transport destinations in these integration tests are temporary local bare
repositories. No private corpus, live Player.log, real GitHub publication, Mac
installation or paid inference is part of this verification.

The current archive/import cadence remains unchanged; this is eventual upload
of a completed archived match, not a claim of instantaneous log-tail upload.
Draft-pick capture and pre-first-match draft upload are separate integrations.
