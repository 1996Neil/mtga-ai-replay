# New draft capture, account isolation and private Git backup

Implementation contract: starting when the service is enabled, retain actual new
17Lands bot or human draft pack/selection observations independently of matches, display them in
Replay under the correct Arena account, and back them up to the existing
configured private data repository. Historical picks are deliberately skipped.
Preserve old replay databases and unrelated local edits. No model calls, raw log
uploads, guessed Course links, final-pool backfill, new third-party dependencies,
deletions, or modification of the 17Lands installation.

## Operation

- `npm run draft:capture`: initialize/capture once. On the first invocation, scan
  retained tracker logs only for account context and complete-line byte cursors.
  Skip historical picks. Initialization fixes each source's byte boundary so a
  concurrently appended new record remains available on the next pass.
- `npm run draft:watch -- --sync`: collect every two seconds while Replay is
  closed or open; back up new data in batches with at least 60 seconds between
  attempts. Upload runs independently and never blocks the collection loop.
- `npm run draft:sync`: explicitly publish and verify the current sanitized
  snapshot. An empty account index can initialize the destination without any
  historical or synthetic game data.
- `npm run draft:install`: install the dedicated macOS LaunchAgent
  `local.mtga.draft-capture`, including collection and Git backup. It reads the
  user's configured private repository through the existing GitHub CLI login.
  If direct GitHub transport is unavailable, `npm run draft:install --
  --https-proxy http://127.0.0.1:PORT` can reuse an already running local HTTP
  proxy for this service only. It does not change system or game network rules;
  credentials and non-loopback proxy addresses are rejected. Existing differing
  service configurations are preserved for explicit maintenance.

Requires Python 3.9+ with its standard library and the existing Node 24 runtime.
CLI options: `--log-dir`, `--data-dir`, `--python`. `--from-start` explicitly opts
into offline/test historical import; the installed service never enables it.
The input is `~/.seventeenlands/seventeenlands.log*`; tracker credentials are
never read. The new private database is `draft-capture.sqlite3`.

## Accounts and viewing

17Lands' explicit `Updating user info` messages identify the account. Both the
observed 26-character alphanumeric Arena ID format and UUID-shaped IDs are
supported. A deterministic domain-separated SHA256 becomes `account_key`; the
original ID is never stored or uploaded. Player names remain in the local
account catalog for the selector; Git stores no account labels.

Account context follows explicit login/logout/reconnect transitions, is persisted
with the cursor, and survives normal rotation. Missing/malformed identities,
truncation or lost oversized records fail to unknown ownership. Unknown-owner
observations remain local and are excluded from Git. No identity is inferred
from event, time, name similarity or the latest match.

Replay provides a game-account selector. Draft and match history requests carry
that account scope; switching clears the previous board and cancels stale
requests. Newly parsed matches also carry the hashed ID from the explicitly
identified local seat. Old matches lacking evidence stay in the separate
“未分类旧记录 / 待识别” view. Existing collections and cloud review publishing
contracts are not retroactively partitioned. This is local viewing organization,
not multi-user authentication; the existing loopback access boundary remains.

## Persistence and interpretation

Observation insertion and complete-line cursor advancement commit together under
SQLite FULL durability. Device/inode and checkpoint identity handle ordinary
renames and truncation. Unfinished UTF-8 lines are reread after restart. Invalid
or oversized draft records leave gaps. No
old archive is changed or cleared.

This adapter supports the installed tracker's bot and human draft log messages,
including Quick Draft, Premier Draft, Traditional Draft, and future event IDs
that follow Arena's event naming rules. Unsupported or malformed lines remain
local gaps and are never guessed into a draft.
Coordinates convert from zero-based to one-based. Duplicate card quantities and
multi-card selections are retained; contradictions remain explicit. Receipt time
is the tracker log time, not Arena action time.

Initial-pack notifications define provisional capture segments, not verified
Course/tournament identities. Source replay may produce duplicate segments.
Nothing is joined to an archived match by a guessed latest course. The UI labels
this boundary and suppresses a misleading 0–0 score. Per-pick completeness means
a consistent observed prefix; `history_complete` always stays false. Any known
capture gap conservatively invalidates prefix exactness. No terminal event or
missing historical selection is invented.

## Git protocol and compatibility

`drafts/index.json` discovers independent account indexes at
`drafts/accounts/<account_key>/index.json`. Each account index binds immutable
100-observation chunks at `objects/<sha256>.json` by exact SHA256, byte length
and count. Indexes are mutable; chunks are immutable. Raw literals, original
account IDs, names, machine paths and credentials are not part of the schema.

The publisher shares the existing upload lock, verified private repository,
fixed service identity, complete-history validation and non-force Git transport.
Root, account indexes and chunks all have strict path-bound schema validation;
existing match/collection/review readers use that same updated guard. Ownership
checks only allow draft files in a draft commit. Existing branches and namespaces
are preserved. Old immutable chunks remain as historical revisions.

Before publication, each remote account's observations must be an exact prefix
of the local account history. Different-device/conflicting lineages block rather
than overwrite. A second stable repository ID/privacy/default-branch check
precedes push. A fetched reachable remote revision must contain every exact
uploaded byte before a local receipt is saved at `draft-sync/receipt.json`.
The database is retained even after verification; no cache eviction is enabled.
Network failure or an ambiguous push leaves local data for retry.

Deploy the new shared guard to active readers/writers before adding `drafts/` to
the data repository: old clients reject this namespace. Updating a frozen
historical delivery is not automatic. Source publication alone does not prove
those copies have been upgraded.

## Verification and rollback

Tests cover interrupted tails, duplicate reads, rotation, truncation, transaction
rollback, bootstrap append races, malformed inputs, real Arena ID formats,
account switch/logout/reconnect, unknown ownership, HTTP account scoping,
conflicts, missing picks, repeated Git sync, append, offline failure, public
repository refusal and successful push with lost response. Git integration tests
use a real temporary bare repository with a synthetic GitHub identity, not the
user's remote. Backend and Viewer checks are separate.

Real initialization confirms account recognition and zero imported historical
picks. The next live draft is still needed to prove a newly generated pick
traverses the real tracker, collector, Viewer and private remote. No synthetic
pick may be uploaded as evidence for that.

To stop the service, unload only its dedicated LaunchAgent. Keep existing game
logs, tracker logs, old databases and the new capture database. Reverting the
source commit removes the display integration; data stays recoverable.
