# MTGA AI Replay source

Replay 2.0 reads cloud-generated reviews from the private data repository. Its
separate server entry is `npm run replay:serve`; it does not load a local model
generator or require model API keys. See the [cloud V1 protocol](docs/CLOUD_REVIEW_PROTOCOL_V1.md),
[Agent write contract](docs/CLOUD_AGENT_REVIEW_CONTRACT.md), and [P0 review](docs/CLOUD_REVIEW_P0_PLAN_20261015.md).
P1 adds an explicitly admitted GitHub writer, independent importance/assessment/confidence,
and worker-isolated validation: [P1 protocol](docs/CLOUD_REVIEW_P1_PROTOCOL.md),
[Chinese P1 report](docs/CLOUD_REVIEW_P1_REPORT_20261015.md), and [test evidence](docs/cloud-review-p1-results.json).
The [Phase 1 audit](docs/REPLAY_AI_AUDIT_20261014.md) and
[previous lifecycle/rollback notes](docs/REPLAY_AI_HARDENING.md) remain historical evidence.
The legacy voice code and launcher remain in Git; the original desktop checkout is not replaced.


This repository contains the MTGA Replay backend, owned Viewer integration,
tests, three lockfiles and local platform tools. It is separate from the
private replay **data** repository. Older optional Coach/Live Coach adapters
remain in the source tree for compatibility, but they are not required by the
replay viewer or replay import workflow.
The latest model-provider work and subsequent manual replay-sync/service-identity
changes are included. Existing applications and frozen delivery snapshots were
not changed by this source export.

Subsequent scoped history-approval safeguards are also preserved: legacy data
history needs an explicit local approval bound to repository, branch, commit and
file hashes. No history approval record or existing data history is uploaded here.

**The repository is public, but 19 existing adapted Viewer files have a separate rights boundary.** Their hashes and upstream revision remain recorded in [restricted-viewer.json](docs/restricted-viewer.json), and attribution is preserved in [viewer/ATTRIBUTION.md](viewer/ATTRIBUTION.md). The inspected upstream revision has no declared code license; the MIT license in [LICENSE](LICENSE) does not grant public redistribution rights for those files. The macOS icon is excluded.

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
npm run viewer:build
npm run test:cloud
npm run check:release
npm start -- --port 8787
```

Dependency installation needs the npm registry or a populated cache. Tests use
only mocked model/TTS responses, synthetic logs, temporary local repositories,
and explicitly deidentified windows. No real GPT/TTS requests are made. `npm test`
retains but explicitly skips eight tests requiring the private locked data
history. `viewer:test` runs the complete Viewer suite. No missing data is replaced
by fabricated passing results. Full reproduction and opt-in commands are in
[DEVELOPMENT.md](docs/DEVELOPMENT.md).

`npm start` serves a disposable **synthetic API** at `127.0.0.1:8787`, using a new
OS-temporary SQLite archive. SIGINT/SIGTERM cleans it up. It does not use real
logs, account settings, collection memory, credentials, model/TTS services,
public card downloads or Git publishing. This development endpoint serves a minimal placeholder HTML page and synthetic API, not the full Viewer UI. `npm run viewer:build` builds the Viewer separately. It uses no private history or live Mac log data.

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

The optional legacy Coach adapters have separate provider catalogs, login and
paid speech authorization. No credentials or grants are packaged; Replay import
and viewing do not call model or speech services.

No raw Player.log, personal SQLite history, credentials, cookies, tokens, account
configuration, audio, card collection/cache, acceptance logs or upstream artwork
is included. Third-party notices and dependency locks are preserved.

## License and reuse

Original Replay source code is released under the MIT License in [LICENSE](LICENSE).
Third-party dependencies, bundled card names, and the adapted Viewer files have
separate notices and may require additional permission. Read
[THIRD_PARTY.md](docs/THIRD_PARTY.md) and [viewer/ATTRIBUTION.md](viewer/ATTRIBUTION.md)
before redistributing those portions.

## Replay 2.0 task and collection review

The review branch adds server-owned task reconnection, completion notification attempts and an explicit collection update button. See [review evidence and limits](docs/REPLAY2_SYNC_REVIEW.md) and [Pro review prompt](docs/PRO_REVIEW_PROMPT.md). No real upload performance improvement is claimed. The included adapted Viewer sources remain hash-checked by the release scan; public visibility does not change their separate upstream licensing status or grant public redistribution rights.

## New draft records by game account

The local 17Lands bridge skips historical picks by default, captures new Quick Draft
observations under the detected Arena account, and offers verified private Git
backup. Replay includes an account selector; records with unknown ownership remain
separate. See [operation, data contract and limits](docs/DRAFT_CAPTURE.md).
