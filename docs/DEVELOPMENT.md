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
npm run test:private-corpus
```

The remaining private-corpus checks cover authorized replay history only. No
private logs, account IDs, credentials or heldout coaching fixtures are required
by the public replay test suite.

## Viewer permission boundary

The 19 existing adapted files listed in restricted-viewer.json remain included for
historical and build compatibility. Preserve attribution and the upstream license
status: no code license was declared, and the repository's MIT license does not
grant public redistribution rights for those files. Do not claim an upstream
license or redistribute those files without the necessary permission. Do not
commit built output.

The materializer remains available for authorized local recovery from an explicit same-version directory:

```bash
npm run viewer:materialize -- --source-dir /path/to/existing/mtga-gpt-replay
npm run viewer:test:full
npm run viewer:build
```

The materializer validates all input hashes before writing, refuses changed files
or symlink ancestors, performs no network request and never edits the source
directory. The release policy scans these Viewer files and verifies their
manifest hashes. Any future transfer or public distribution still requires the
necessary rights; this private PR authorization does not supply them.

The macOS launcher icon also needs rights verification and an explicit local
asset before installing the native launcher. Installation is outside cloud setup.

Replay setup does not require model, voice or paid-provider credentials. No paid
endpoint is part of npm setup, start, test or release scanning.
