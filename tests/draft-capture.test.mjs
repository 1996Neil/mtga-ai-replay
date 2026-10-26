import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectDraftCaptures, readDraftCapture } from '../src/draft-capture.mjs';
import { startReplayServer } from '../src/server.mjs';
const run = promisify(execFile);
let seq = 0;
const observation = (kind, p, n, card_ids) => ({ observation_id: (++seq).toString(16).padEnd(64, 'a'),
  kind, event_id: 'QuickDraft_SYNTHETIC_20261024', pack_number: p, pick_number: n, card_ids,
  logged_at: '2026-10-24T01:02:03.123+08:00' });

test('Python capture atomicity, rotation, malformed inputs and restart suite', async () => {
  const result = await run('python3', [fileURLToPath(new URL('./draft-capture-python.py', import.meta.url))]);
  assert.match(result.stderr, /Ran 14 tests/);
  assert.match(result.stderr, /OK/);
});

test('duplicate candidates, explicit selections and unbound segment survive projection', () => {
  const [draft] = projectDraftCaptures([
    observation('pack', 1, 1, [10, 10, 11]), observation('pick', 1, 1, [10]),
    observation('pack', 1, 2, [10, 11]), observation('pick', 1, 2, [11]),
  ]);
  assert.equal(draft.binding, 'unresolved'); assert.deepEqual(draft.matches, []);
  assert.equal(draft.picks[0].candidates.length, 3);
  assert.deepEqual(draft.picks[1].pool_after.map(c => c.arena_id), [10, 11]);
  assert.equal(draft.picks[1].complete, true);
  assert.equal(draft.history_complete, false);
});

test('prior holes, cross-pack holes and conflicts invalidate the whole subsequent prefix', () => {
  const observations = [observation('pack', 1, 1, [10, 11]), observation('pick', 1, 1, [10]),
    observation('pack', 2, 1, [12, 13]), observation('pick', 2, 1, [12]),
    observation('pack', 2, 2, [13]), observation('pick', 2, 2, [13])];
  const [draft] = projectDraftCaptures(observations);
  assert.equal(draft.picks[1].complete, false); assert.equal(draft.picks[2].complete, false);
  const [conflict] = projectDraftCaptures([...observations, observation('pick', 2, 2, [14])]);
  assert.equal(conflict.picks[2].selected, null);
  assert.ok(conflict.picks[2].missing.includes('conflicting_observations'));
});

test('multi-card selections retained with unsupported completeness and gaps stay conservative', () => {
  const events = [observation('pack', 1, 1, [10, 11]), observation('pick', 1, 1, [10, 11])];
  const [draft] = projectDraftCaptures(events);
  assert.deepEqual(draft.picks[0].selected_ids, [10, 11]);
  assert.equal(draft.picks[0].complete, false);
  assert.ok(draft.picks[0].missing.includes('unsupported_multi_pick'));
  assert.equal(projectDraftCaptures(events, { gaps: 1 })[0].picks[0].pool_exact, false);
});

test('repeated initial pack does not merge separate progressed segments or different packs', () => {
  const events = [observation('pack', 1, 1, [10, 11]), observation('pack', 1, 1, [10, 11]),
    observation('pick', 1, 1, [10]), observation('pack', 1, 2, [11]),
    observation('pack', 1, 1, [10, 11]), observation('pick', 1, 1, [11])];
  const runs = projectDraftCaptures(events);
  assert.equal(runs.length, 2);
  assert.notEqual(runs[0].run_id, runs[1].run_id);
  assert.equal(projectDraftCaptures([observation('pack', 1, 1, [10]), observation('pack', 1, 1, [11])]).length, 2);
});

test('real collector output reaches HTTP without a match or legacy database, published session stays separate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'draft-capture-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logDir = join(root, 'logs'), dataDir = join(root, 'data'), viewerDir = join(root, 'viewer');
  await mkdir(logDir); await mkdir(viewerDir); await writeFile(join(viewerDir, 'index.html'), 'Synthetic');
  await writeFile(join(logDir, 'seventeenlands.log'),
    "20261024 010203.123,INFO,tracker,Draft pack: {'event_name': 'QuickDraft_SYNTHETIC', 'pack_number': 0, 'pick_number': 0, 'card_ids': [10, 11]}\n" +
    "20261024 010204.123,INFO,tracker,Draft pick: {'event_name': 'QuickDraft_SYNTHETIC', 'pack_number': 0, 'pick_number': 0, 'card_ids': [11]}\n");
  await run('python3', [fileURLToPath(new URL('../tools/draft-capture/capture.py', import.meta.url)), '--from-start', '--log-dir', logDir, '--data-dir', dataDir]);
  assert.equal((await readDraftCapture({ dataDir })).observations.length, 2);
  const server = await startReplayServer({ dataDir, viewerDir, observeLocalLogs: false, displayNamesZh: new Map(), cardNames: new Map([[11, 'Synthetic card']]) });
  t.after(() => server.close());
  assert.deepEqual(await fetch(server.url + 'api/draft-runs').then(r => r.json()), []);
  await mkdir(join(dataDir, 'draft-sync'));
  const ids = (await readDraftCapture({ dataDir })).observations.map(item => item.observation_id);
  await writeFile(join(dataDir, 'draft-sync/published.json'), JSON.stringify({ verified: true,
    revision: 'a'.repeat(40), observation_ids: ids }));
  const result = await fetch(server.url + 'api/draft-runs').then(r => r.json());
  assert.equal(result.length, 1); assert.equal(result[0].picks[0].selected.name, 'Synthetic card');
  const published = await startReplayServer({ dataDir, viewerDir, observeLocalLogs: false, displayNamesZh: new Map(), sourceIdentity: { kind: 'published-history' } });
  t.after(() => published.close());
  assert.deepEqual(await fetch(published.url + 'api/draft-runs').then(r => r.json()), []);
});
