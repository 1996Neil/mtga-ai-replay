#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultDataDir } from '../src/history.mjs';
import { readCoachSyncState } from '../src/coach-sync.mjs';
import { reviewPath } from '../src/review/cloud-review-contract.mjs';
import { openPublishedReplaySession } from '../src/review/published-replay-session.mjs';
import { startReplayServer } from '../src/server.mjs';

// Explicit opt-in, never used by the installed desktop launcher. The settings
// are read once; source fetch state lives in a distinct revision-scoped directory.
const { values } = parseArgs({ options: { revision: { type: 'string' }, match: { type: 'string' },
  game: { type: 'string', default: '1' }, port: { type: 'string', default: '0' },
  'data-dir': { type: 'string' }, 'viewer-dir': { type: 'string' } } });
const revision = values.revision, gameNumber = Number(values.game), port = Number(values.port);
reviewPath(values.match, gameNumber);
if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision ?? '') || !Number.isSafeInteger(port) || port < 0 || port > 65535) throw Error('Explicit full revision and valid port required.');
const root = values['data-dir'] ?? defaultDataDir(), settings = await readCoachSyncState(root);
const dataDir = await mkdtemp(join(root, `published-history-${revision.slice(0, 12)}-`));
await mkdir(join(dataDir, 'coach-sync'), { recursive: true, mode: 0o700 });
// Retain configured approval exactly. This cannot manufacture historical consent.
await writeFile(join(dataDir, 'coach-sync/state.json'), JSON.stringify({ schema: 'MTGA_LOCAL_SYNC_V1', enabled: settings.enabled, repository: settings.repository,
  pending: [], synced: {}, history_approval: settings.history_approval }), { mode: 0o600, flag: 'wx' });
const session = await openPublishedReplaySession({ matchId: values.match, gameNumber, revision, dataDir });
const runtime = await startReplayServer({ dataDir, port, viewerDir: values['viewer-dir'], writeInfo: false,
  replayProvider: session.replayProvider, reviewReader: session.reviewReader, sourceIdentity: session.identity,
  cardMetadata: new Map(session.cards.map(card => [card.arena_id, card])), displayNamesZh: new Map(),
  includeLocalHistory: false, observeLocalLogs: false, enableReplaySync: false, enableCollection: false });
console.log(`历史发布源 ${revision} · 只读 ${runtime.url}`);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await runtime.close(); process.exit(0); });
