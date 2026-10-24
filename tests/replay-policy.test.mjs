import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTutorialMatch } from '../src/replay-policy.mjs';
import { archiveReplays, excludeArchivedReplays, getReplay, listReplays, saveCoachNotes, isReplayExcluded } from '../src/history.mjs';
import { buildCoachBundle } from '../src/coach-bundle.mjs';
import { enqueueCoachBundle } from '../src/coach-sync.mjs';

const replay = (id, event = 'Ladder') => ({
  schema_version: '2.0', match: { id, event_id: event, event, started_at: '2026-10-24T00:00:00.000Z' },
  games: [], deck: [],
});
test('only explicit tutorial modes are excluded', () => {
  for (const key of ['event_id', 'event', 'queue_id', 'mode']) {
    assert.equal(isTutorialMatch({ [key]: 'NPE_Tutorial_PlayFamiliar1' }), true);
  }
  assert.equal(isTutorialMatch({ event: 'Tutorial_Intro' }), true);
  for (const event of ['DualColorPrecons', 'QuickDraft_FRA_20261008', 'Jump_In_2024', 'Ladder', 'Play', 'MWM_HistoricPauper_20261006', 'NotTutorial', '']) {
    assert.equal(isTutorialMatch({ event }), false);
  }
});
test('tutorials never enter the archive or upload bundle', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mtga-exclusion-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const tutorial = replay('synthetic-tutorial', 'NPE_Tutorial_PlayFamiliar5');
  assert.equal((await archiveReplays([tutorial, replay('synthetic-normal')], { dataDir })).archived, 1);
  assert.equal(await getReplay(tutorial.match.id, { dataDir }), null);
  assert.deepEqual((await listReplays({ dataDir })).map(r => r.id), ['synthetic-normal']);
  await assert.rejects(buildCoachBundle(tutorial), /Tutorial replays are excluded/);
  await assert.rejects(enqueueCoachBundle({ summary: { match_id: tutorial.match.id, mode: tutorial.match.event } }, { dataDir }), { code: 'SYNC_EXCLUDED' });
});
test('explicit deletion removes notes and prevents retained-log reimport and stale upload', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mtga-deletion-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const removed = replay('synthetic-deleted'), kept = replay('synthetic-kept');
  await archiveReplays([removed, kept], { dataDir });
  await saveCoachNotes(removed.match.id, [{ text: 'Synthetic' }], { dataDir });
  const bundle = await buildCoachBundle(removed);
  assert.deepEqual(await excludeArchivedReplays([removed.match.id], { dataDir }), { deleted: 1 });
  assert.equal(await isReplayExcluded(removed.match.id, { dataDir }), true);
  assert.equal(await getReplay(removed.match.id, { dataDir }), null);
  assert.equal((await archiveReplays([removed], { dataDir })).archived, 0);
  await assert.rejects(enqueueCoachBundle(bundle, { dataDir }), { code: 'SYNC_EXCLUDED' });
  assert.deepEqual((await listReplays({ dataDir })).map(r => r.id), [kept.match.id]);
});
