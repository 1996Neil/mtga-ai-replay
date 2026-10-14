# MTGA AI Replay source

Replay 2.0 now has a separate post-game UI and server entry: `npm run replay:serve`.
See [independent Phase 1 audit and reuse comparison](docs/REPLAY_AI_AUDIT_20261014.md)
and [task API, operation and rollback](docs/REPLAY_AI_HARDENING.md).
The legacy voice code and launcher remain in Git; the original desktop checkout is not replaced.


This repository contains the latest owned replay/Live Coach backend, model and
speech adapters, owned Viewer integration, tests, three lockfiles and local
platform tools. It is separate from the private coaching **data** repository.
The latest model-provider work and subsequent manual replay-sync/service-identity
changes are included. Existing applications and frozen delivery snapshots were
not changed by this source export.

Subsequent scoped history-approval safeguards are also preserved: legacy data
history needs an explicit local approval bound to repository, branch, commit and
file hashes. No history approval record or existing data history is uploaded here.

**Full Viewer builds on a fresh clone are blocked by third-party permission.**
18 copied/adapted upstream files and one stylesheet with unresolved provenance
are excluded. Their exact latest hashes and upstream revision are recorded in
[restricted-viewer.json](docs/restricted-viewer.json). Owned LiveCoachPanel,
LiveCoachSetup, model settings and audio/view guards are included. See
[THIRD_PARTY.md](docs/THIRD_PARTY.md); private visibility does not establish an
upstream redistribution license. The macOS icon is also excluded.

## Linux development

Use Node **24.x**, Git, and a normal Linux x64/arm64 npm environment. Keep optional
dependencies for the platform-native Vite/Tailwind tooling. Do not reuse Mac
node_modules. From a fresh clone:

```bash
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix viewer
npm test
npm run coach:test
npm run viewer:test
npm run test:cloud
npm run check:release
npm start -- --port 8787
```

Dependency installation needs the npm registry or a populated cache. Tests use
only mocked model/TTS responses, synthetic logs, temporary local repositories,
and explicitly deidentified windows. No real GPT/TTS requests are made. `npm test`
retains but explicitly skips eight tests requiring the private locked data
history; `viewer:test` excludes three files importing the withheld Viewer stores.
No missing data is replaced by fabricated passing results. Full reproduction
and opt-in commands are in [DEVELOPMENT.md](docs/DEVELOPMENT.md).

`npm start` serves a disposable **synthetic API** at `127.0.0.1:8787`, using a new
OS-temporary SQLite archive. SIGINT/SIGTERM cleans it up. It does not use real
logs, account settings, collection memory, credentials, model/TTS services,
public card downloads or Git publishing. This API entry is usable without the
restricted Viewer; it is not the complete replay UI.

The server enforces loopback Host/Origin. Use curl inside the workspace or an
existing authenticated port-forward that preserves the loopback origin. This
repository does not relax access controls or deploy a public service.

## Local runtime boundaries

The normal CLI and macOS launcher remain source-only tools for the existing local
workflow. A Linux cloud workspace cannot observe a Mac's Player.log or play audio
on that Mac by itself. The collection reader/native helper and launcher require
separate local installation and authorization; do not execute them during cloud
setup. The collection publisher's personal repository binding was replaced in
this export with `example-user/mtga-replay-data`; configure it deliberately before
any separately authorized real collection publishing.

SIWC and DeepSeek selection are explicit. Provider catalogs, inference, login,
and paid speech remain separately authorized actions. No credentials or grants
are packaged; setting up cloud source access grants no permission for model/TTS
calls. Real model strategy quality, real model-to-speech integration and new-game
active coaching remain unverified.

No raw Player.log, personal SQLite history, credentials, cookies, tokens, account
configuration, audio, card collection/cache, acceptance logs or upstream artwork
is included. Third-party notices and dependency locks are preserved.

## Replay 2.0 task and collection review

The review branch adds server-owned task reconnection, completion notification attempts and an explicit collection update button. See [review evidence and limits](docs/REPLAY2_SYNC_REVIEW.md) and [Pro review prompt](docs/PRO_REVIEW_PROMPT.md). No real upload performance improvement is claimed. Restricted Viewer files remain excluded; their current local hashes are updated for authorized materialization.
