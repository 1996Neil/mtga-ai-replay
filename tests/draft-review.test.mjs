import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { draftReviewFingerprint, validateDraftReview, bindDraftReview, readDraftReview, MAX_DRAFT_REVIEW_BYTES } from '../src/review/draft-review.mjs';
import { projectDraftCaptures } from '../src/draft-capture.mjs';
import { startReplayServer } from '../src/server.mjs';

const account = 'a'.repeat(64), runId = 'b'.repeat(32);
const a = { arena_id: 10, name: 'Synthetic A' }, b = { arena_id: 11, name: 'Synthetic B' };
const pick = { pack_number: 1, pick_number: 1, candidates: [a, b], selected: a,
  pool_before: [], pool_after: [a], complete: true, missing: [] };
function fixture() {
  const run = { run_id: runId, account_key: account, event_id: 'QuickDraft_SYNTHETIC', picks: [structuredClone(pick)] };
  const report = { schema: 'MTGA_DRAFT_AI_REVIEW_V1', run_id: runId, account_key: account,
    event_id: run.event_id, source_fingerprint: draftReviewFingerprint(run), generated_at: '2026-10-30T10:00:00.000Z',
    summary: { headline: '合成选牌复盘', overview: '仅用于验证数据绑定。', limitations: ['仅抽查一手。'] },
    notes: [{ pack_number: 1, pick_number: 1, importance: 'normal', assessment: 'positive', confidence: 'medium',
      title: '合成评论', observation: '实际选A。', suggestion: '比较A和B。', rationale: '合成依据。', limitation: '不代表真实策略。',
      selected: a, alternative: b }] };
  return { run, report };
}
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'mtga-draft-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('binding covers candidate multiplicity, selected card and entire prior pool, ignoring display translations', () => {
  const { run, report } = fixture();
  assert.equal(bindDraftReview(report, run, account).status, 'ready');
  const translated = structuredClone(run);
  translated.picks[0].candidates[0].name = '合成A';
  assert.equal(draftReviewFingerprint(translated), draftReviewFingerprint(run));
  for (const mutate of [
    value => value.picks[0].candidates.push(a),
    value => { value.picks[0].selected = b; },
    value => value.picks[0].pool_before.push(b),
    value => { value.picks[0].complete = false; },
  ]) {
    const changed = structuredClone(run); mutate(changed);
    assert.equal(bindDraftReview(report, changed, account).status, 'stale');
  }
  assert.throws(() => bindDraftReview(report, { ...run, account_key: 'c'.repeat(64) }, 'c'.repeat(64)));
  assert.throws(() => bindDraftReview(report, { ...run, run_id: 'd'.repeat(32) }, account));
});
test('malformed notes, duplicate picks, unknown comparison and oversized report are rejected', () => {
  for (const mutate of [
    value => value.notes.push(value.notes[0]),
    value => { value.notes[0].assessment = 'certain-error'; },
    value => { value.notes[0].alternative = { arena_id: 90, name: 'Outside pack' }; },
    value => { value.notes[0].rationale = 'x'.repeat(MAX_DRAFT_REVIEW_BYTES); },
    value => { value.extra = true; },
  ]) {
    const { run, report } = fixture(); mutate(report);
    assert.throws(() => bindDraftReview(report, run, account));
  }
  const { run } = fixture();
  run.picks.push(structuredClone(run.picks[0]));
  assert.throws(() => draftReviewFingerprint(run));
});
test('missing reports differ from invalid files and directory symlinks', async t => {
  const dataDir = await temporary(t), { run, report } = fixture();
  assert.equal((await readDraftReview(run, { dataDir, accountKey: account })).status, 'missing');
  const directory = join(dataDir, 'draft-reviews', account);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${runId}.json`);
  await writeFile(path, JSON.stringify(report));
  assert.equal((await readDraftReview(run, { dataDir, accountKey: account })).status, 'ready');
  await writeFile(path, '{"schema":');
  assert.equal((await readDraftReview(run, { dataDir, accountKey: account })).status, 'error');
  await writeFile(path, 'x'.repeat(MAX_DRAFT_REVIEW_BYTES + 1));
  assert.equal((await readDraftReview(run, { dataDir, accountKey: account })).status, 'error');
  await rm(path);
  await symlink(join(dataDir, 'outside.json'), path);
  assert.equal((await readDraftReview(run, { dataDir, accountKey: account })).status, 'error');
  await rm(path); await rm(directory, { recursive: true });
  await mkdir(join(dataDir, 'elsewhere'));
  await symlink(join(dataDir, 'elsewhere'), directory);
  assert.equal((await readDraftReview(run, { dataDir, accountKey: account })).status, 'error');
});
test('HTTP review requires account scope, reads actual capture and preserves published-history isolation', async t => {
  const dataDir = await temporary(t), viewerDir = join(dataDir, 'viewer');
  await mkdir(viewerDir); await writeFile(join(viewerDir, 'index.html'), '<title>Synthetic</title>');
  const observations = [
    { observation_id: '1'.repeat(64), kind: 'pack', card_ids: [10, 11] },
    { observation_id: '2'.repeat(64), kind: 'pick', card_ids: [10] },
  ].map(value => ({ ...value, account_key: account, event_id: 'QuickDraft_SYNTHETIC',
    pack_number: 1, pick_number: 1, logged_at: '2026-10-30T10:00:00.000+08:00' }));
  const db = new DatabaseSync(join(dataDir, 'draft-capture.sqlite3'));
  db.exec('CREATE TABLE observations(seq INTEGER PRIMARY KEY, observation_id TEXT, body TEXT); CREATE TABLE gaps(gap_id TEXT); CREATE TABLE accounts(account_key TEXT,label TEXT); CREATE TABLE meta(key TEXT,value TEXT)');
  observations.forEach((row, i) => db.prepare('INSERT INTO observations VALUES(?,?,?)').run(i + 1, row.observation_id, JSON.stringify(row)));
  db.close();
  await mkdir(join(dataDir, 'draft-sync'));
  await writeFile(join(dataDir, 'draft-sync/published.json'), JSON.stringify({
    verified: true, revision: 'a'.repeat(40), observation_ids: observations.map(value => value.observation_id),
  }));
  const [run] = projectDraftCaptures(observations);
  const { report } = fixture(); report.run_id = run.run_id; report.source_fingerprint = draftReviewFingerprint(run);
  const execute = promisify(execFile), importScript = new URL('../bin/mtga-draft-review-import.mjs', import.meta.url);
  const sequence = createHash('sha256').update(JSON.stringify(run.picks.map(pick => ({
    pack: pick.pack_number, pick: pick.pick_number, candidates: pick.candidates.map(card => card.arena_id), selected: pick.selected_ids,
  })))).digest('hex');
  const evidence = { event_id: run.event_id, sequence_id: sequence, observed_accounts: [account],
    observed_segments: [run.run_id], picks: run.picks };
  const legacy = { event_id: run.event_id, sequence_id: sequence, title: '导入测试', overview: '合成来源。',
    notes: [{ pack_number: 1, pick_number: 1, assessment: '保留', selected: a, alternative: b,
      title: 'A的独立强度更高', suggestion: '这手选A。',
      rationale: 'A能直接处理生物，B需要另有配合。', limitation: '测试用途。' }] };
  const reportInput = join(dataDir, 'import-analysis.json'), evidenceInput = join(dataDir, 'import-evidence.json');
  await writeFile(reportInput, JSON.stringify(legacy)); await writeFile(evidenceInput, JSON.stringify(evidence));
  const importArgs = [importScript.pathname, '--report', reportInput, '--evidence', evidenceInput, '--data-dir', dataDir];
  assert.match((await execute(process.execPath, importArgs)).stdout, /"status":"ready"/);
  assert.match((await execute(process.execPath, importArgs)).stdout, /"status":"ready"/);
  const { readFile, readdir } = await import('node:fs/promises');
  const savedPath = join(dataDir, 'draft-reviews', account, `${run.run_id}.json`);
  const preserved = await readFile(savedPath, 'utf8');
  const imported = JSON.parse(preserved);
  assert.equal(imported.notes[0].title, 'A的独立强度更高');
  assert.equal(imported.notes[0].suggestion, '这手选A。');
  assert.equal(imported.notes[0].rationale, 'A能直接处理生物，B需要另有配合。');
  await writeFile(reportInput, JSON.stringify({ ...legacy, title: '不得覆盖旧报告' }));
  await assert.rejects(execute(process.execPath, importArgs));
  assert.equal(await readFile(savedPath, 'utf8'), preserved);
  assert.deepEqual((await readdir(join(dataDir, 'draft-reviews', account))).sort(), [`${run.run_id}.json`]);
  await mkdir(join(dataDir, 'draft-reviews', account), { recursive: true });
  await writeFile(join(dataDir, 'draft-reviews', account, `${run.run_id}.json`), JSON.stringify(report));
  const options = { dataDir, viewerDir, observeLocalLogs: false, displayNamesZh: new Map(), cardNames: new Map([[10, 'Synthetic A']]) };
  const server = await startReplayServer(options);
  t.after(() => server.close());
  const path = `api/draft-runs/${run.run_id}/review`;
  assert.equal((await fetch(server.url + path)).status, 400);
  assert.equal((await fetch(`${server.url}${path}?account=${'c'.repeat(64)}`)).status, 404);
  assert.equal((await fetch(`${server.url}${path}?account=${account}&extra=1`)).status, 400);
  const ready = await fetch(`${server.url}${path}?account=${account}`);
  assert.equal(ready.status, 200);
  assert.equal(ready.headers.get('cache-control'), 'no-store');
  assert.equal((await ready.json()).review.notes.length, 1);
  assert.equal((await fetch(`${server.url}${path}?account=${account}`, { method: 'POST' })).status, 405);
  const isolated = await startReplayServer({ ...options, sourceIdentity: { kind: 'published-history' } });
  t.after(() => isolated.close());
  assert.equal((await fetch(`${isolated.url}${path}?account=${account}`)).status, 400);
});
