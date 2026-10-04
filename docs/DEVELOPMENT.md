# Reproduction and limits

Fresh Linux setup uses the commands in the root README. Node 24 is required for
built-in SQLite and the TypeScript test loader. Root npm installation does not
install or execute the optional macOS collection helper. Lifecycle scripts are
disabled; optional platform bindings must remain enabled for Viewer tooling.

## Retained private-corpus checks

The complete original tests are retained. Eight cases resolve private Git
objects at the locked `LOCKED_REPLAY_REF`; that data history is intentionally
absent from this source repository. They are visibly marked skipped by the
portable test runner. To run them locally, point to your existing authorized
data checkout and the original local heldout fixture, which contains the private
integrity inventory. Neither file is downloaded or uploaded by these commands:

```bash
MTGA_PRIVATE_CORPUS_DIR=/path/to/existing/private-data-checkout \
MTGA_PRIVATE_HELDOUT_FIXTURE=/path/to/original/live-coach-heldout-windows.json \
npm run test:private-corpus
```

The deidentified rule windows remain the same current-perspective observations:
names Me/Opponent, empty unknown opponent hands, no account IDs, no raw logs or
future-result fields in inference inputs. Stable match/state IDs exist only to
join regression cases. The heldout archive timestamp/path/hash inventory was
excluded from the exported JSON; its original copy remains local.

## Viewer permission boundary

Do not commit the 19 files listed in restricted-viewer.json or any built output.
After confirming your right to use your existing local adaptation, restore it
only on a local machine from the explicit same-version directory:

```bash
npm run viewer:materialize -- --source-dir /path/to/existing/mtga-gpt-replay
npm run viewer:test:full
npm run viewer:build
```

The materializer validates all input hashes before writing, refuses changed files
or symlink ancestors, performs no network request and never edits the source
directory. Restored files are individually gitignored and denied by release
policy. A new cloud machine still lacks these files; transferring them to that
machine is not authorized by this repository's export. Obtain upstream permission
or independently replace the affected components before claiming a self-contained
cloud Viewer build. A plain patch can contain restricted lines and is not shipped.

The macOS launcher icon also needs rights verification and an explicit local
asset before installing the native launcher. Installation is outside cloud setup.

## Model and voice checks

The explicit model catalog, strict checked-candidate output contract, DeepSeek
bounded request/budget ledger, cancellation and Chinese-advice leases are covered
offline. Tests use clearly synthetic tokens/keys and non-audio transport bytes.
Passing them proves code contracts, not model quality, real latency, pronunciation
or acoustic cancellation. A user-approved service pilot and controllable practice
match remain necessary for those claims. No paid endpoint is part of npm setup,
start, test, or release scanning.
