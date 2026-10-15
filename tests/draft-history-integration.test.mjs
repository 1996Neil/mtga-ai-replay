import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReplayServer } from '../src/server.mjs';
import { archiveReplays } from '../src/history.mjs';
import { buildDraftRunIndex, saveDraftRunIndex } from '../src/draft-runs.mjs';

test('HTTP history retains two separate draft runs and their individual match results', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'draft-history-integration-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const viewerDir = join(dataDir, 'viewer'); await mkdir(viewerDir);
  await writeFile(join(viewerDir, 'index.html'), '<title>Synthetic</title>');
  const history = ['a', 'b', 'c'].map((id, i) => ({ id, started_at: `2026-10-15T0${i}:00:00Z`, event_id: 'QuickDraft_FRA', result: i === 1 ? 'Loss' : 'Win', game_count: 1 }));
  await archiveReplays(history.map(match => ({ match, games: [{ game_number: 1 }], deck: [] })), { dataDir });
  const records = history.flatMap((match, i) => [
    { Course: { CourseId: i < 2 ? 'course-one' : 'course-two', InternalEventName: 'QuickDraft_FRA', CurrentModule: 'Play', CurrentWins: 1, CurrentLosses: i < 2 ? 1 : 0, CourseDeck: { MainDeck: [] }, CardPool: [] } },
    { matchGameRoomStateChangedEvent: { gameRoomInfo: { gameRoomConfig: { matchId: match.id, reservedPlayers: [{ systemSeatId: 1, eventId: 'QuickDraft_FRA' }] } } } },
    { greToClientEvent: { greToClientMessages: [{ type: 'GREMessageType_ConnectResp', systemSeatIds: [1] }] } },
  ]);
  await saveDraftRunIndex(buildDraftRunIndex(records, history), { dataDir });
  const server = await startReplayServer({ dataDir, viewerDir, observeLocalLogs: false, displayNamesZh: new Map() });
  t.after(() => server.close());
  const response = await fetch(server.url + 'api/draft-runs');
  assert.equal(response.status, 200);
  const runs = await response.json();
  assert.equal(runs.length, 2);
  const first = runs.find(run => run.matches.some(match => match.id === 'a'));
  assert.deepEqual([first.replay_wins, first.replay_losses], [1, 1]);
  assert.deepEqual(first.matches.map(match => match.id).sort(), ['a', 'b']);
  const second = runs.find(run => run.matches.some(match => match.id === 'c'));
  assert.deepEqual([second.replay_wins, second.replay_losses], [1, 0]);
  assert.equal((await fetch(server.url + 'api/matches').then(r => r.json())).length, 3);
});

test('published-history session never reads the local draft sidecar', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'published-draft-boundary-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const viewerDir = join(dataDir, 'viewer'); await mkdir(viewerDir);
  await writeFile(join(viewerDir, 'index.html'), '<title>Synthetic</title>');
  await writeFile(join(dataDir, 'draft-runs.sqlite3'), 'corrupt local database must never be opened');
  const server = await startReplayServer({ dataDir, viewerDir, observeLocalLogs: false, displayNamesZh: new Map(), sourceIdentity: { kind: 'published-history' } });
  t.after(() => server.close());
  const response = await fetch(server.url + 'api/draft-runs');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), []);
});

test('integrated UI retains draft groups, published source label and outer menu closing', async () => {
  const app = await readFile(new URL('../viewer/src/App.tsx', import.meta.url), 'utf8');
  for (const pattern of [/draftRuns\.map/, /run\.replay_wins/, /run\.replay_losses/, /publishedSource\.revision/, /ref=\{historyPicker\}/, /void refreshDraftRuns\(\)/]) assert.match(app, pattern);
  assert.doesNotMatch(app, /closest\('details'\)/);
  assert.match(app, /historyPicker\.current\.open = false/);
});
