import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bundle, filesForBundle, reportForSource } from './helpers/cloud-review-fixture.mjs';
import { readPublishedReviewSource, validateCloudReviewBinding, adaptCloudReview } from '../src/review/cloud-review.mjs';
import { parseCloudReview, reviewPath, isReviewSyncPath } from '../src/review/cloud-review-contract.mjs';
import { validateBundleFiles, isCoachSyncPath, isCollectionSyncPath } from '../src/sync-security.mjs';
import { serializeCoachJson } from '../src/coach-bundle.mjs';
import { visibleCardNames } from '../src/review/review-model.mjs';
const REVISION = 'a'.repeat(40);
const make = async () => { const value = await bundle({ richer: true, coachOptions: { multipart: true } });
  const files = filesForBundle(value), source = readPublishedReviewSource({ files, matchId: value.summary.match_id, revision: REVISION });
  return { value, files, source, report: reportForSource(source) }; };
const rejected = error => ['MTGA_CLOUD_REVIEW', 'MTGA_SYNC_SECURITY'].includes(error.code);

test('strict V1 roundtrip preserves importance but never promotes a legacy claim to a proven error', async () => {
  const { source, report } = await make(); report.notes[0].severity = 'critical';
  assert.deepEqual(parseCloudReview(JSON.stringify(report)), report);
  const result = await adaptCloudReview(report, source);
  assert.equal(result.status, 'ready'); assert.equal(result.review.notes[0].severity, 'tip');
  assert.equal(result.review.notes[0].importance, 'critical');
  assert.equal(result.review.notes[0].assessment, 'possible_error');
  assert.equal(result.review.notes[0].confidence, 'low');
  assert.equal(result.review.notes[0].cards[0], 'Forest');
  assert.equal(result.review.source_content_hash, source.content_hash);
  assert.equal(result.review.summary.limitations[0], report.coverage.limitations[0]);
});

test('V2 importance, assessment and confidence vary independently; unsupported certainty fails closed', async () => {
  const { source, report } = await make(); report.schema = 'MTGA_AI_REVIEW_V2';
  delete report.notes[0].severity;
  for (const importance of ['critical', 'major', 'normal']) for (const assessment of ['suggestion', 'possible_error', 'positive']) for (const confidence of ['low', 'medium', 'high']) {
    Object.assign(report.notes[0], { importance, assessment, confidence });
    assert.equal(validateBundleFiles(new Map([[reviewPath(report.match_id, 1), JSON.stringify(report)]])).ok, true);
    const { review } = await adaptCloudReview(report, source);
    assert.equal(review.notes[0].importance, importance); assert.equal(review.notes[0].assessment, assessment);
    assert.equal(review.notes[0].confidence, confidence);
  }
  report.notes[0].assessment = 'confirmed_error';
  assert.throws(() => validateCloudReviewBinding(report, source), rejected);
  report.notes[0].assessment = 'possible_error'; report.notes[0].proof = 'AI 自称证明';
  assert.throws(() => parseCloudReview(JSON.stringify(report)), rejected);
});

test('review history is readable but never acquires replay or collection write authority', async () => {
  const { report } = await make(), path = reviewPath(report.match_id, 1);
  assert.equal(isReviewSyncPath(path), true); assert.equal(isCoachSyncPath(path), false); assert.equal(isCollectionSyncPath(path), false);
  assert.equal(validateBundleFiles(new Map([[path, JSON.stringify(report)]])).ok, true);
  for (const path of ['reviews/../index.json', 'reviews/x/game-01.json', 'reviews/x/game-0.json', 'reviews/x/game-1000.json',
    'reviews/x/game-1.json/extra', 'reviews/%2e%2e/game-1.json', 'reviews/x/game-1.JSON', 'reviews/x/../game-1.json', 'reviews/x/game-1.json.log']) {
    assert.equal(isReviewSyncPath(path), false); assert.throws(() => validateBundleFiles(new Map([[path, '{}']])), rejected);
  }
  assert.throws(() => validateBundleFiles(new Map([['reviews/another-match/game-1.json', JSON.stringify(report)]])), rejected);
});

test('unknown fields, hidden hand payloads, credential/path/internal IDs, duplicate keys and oversize are rejected', async () => {
  const { report } = await make(), path = reviewPath(report.match_id, 1);
  for (const mutate of [r => { r.opponent = { hand: [{ name: 'Island' }] }; }, r => { r.notes[0].account_id = 'synthetic-private'; },
    r => { r.notes[0].rationale = '中文 /Users/SyntheticPrivate/file'; }, r => { r.notes[0].rationale = '中文 ghp_SYNTHETIC_SECRET_VALUE'; },
    r => { r.summary.overview = '中'.repeat(128 * 1024); }, r => { r.summary.other = {}; },
    r => { r.generated_at = '2026-02-30T00:00:00.000Z'; }, r => { r.notes[0].suggestion = 'English only'; }]) {
    const copy = structuredClone(report); mutate(copy);
    assert.throws(() => validateBundleFiles(new Map([[path, JSON.stringify(copy)]])), rejected);
  }
  const json = JSON.stringify(report).replace('"schema":', '"discarded":{"password":"synthetic-secret"},"discarded":null,"schema":');
  assert.throws(() => parseCloudReview(json), /duplicate-key/);
  assert.throws(() => parseCloudReview(Buffer.from([0xff])), /utf8/);
  assert.throws(() => parseCloudReview(JSON.stringify(report).replace('"schema":', '"sch\\u0065ma":"other","schema":')), /duplicate-key/);
});

test('source hash/policy become stale; game, anchor, boundary and visible card errors are never remapped', async () => {
  const { source, report } = await make();
  for (const key of ['source_content_hash', 'policy_version']) {
    const copy = structuredClone(report); copy[key] = key === 'source_content_hash' ? 'b'.repeat(64) : 'cloud-visible/old';
    assert.equal(validateCloudReviewBinding(copy, source).status, 'stale');
  }
  for (const mutate of [r => { r.match_id = 'another-match'; }, r => { r.game_number = 2; },
    r => { r.notes[0].anchor = 'T99-A99'; }, r => { r.notes[0].boundary = 'before'; r.coverage.inspected[0].boundary = 'before'; },
    r => { r.notes[0].cards = ['Island']; }, r => { r.notes[0].cards = ['树林']; },
    r => { r.coverage.actions_total++; }, r => { r.coverage.states_resolved++; },
    r => { r.coverage.scope = 'all_actions'; }, r => { r.coverage.inspected = []; },
    r => { r.notes.push(structuredClone(r.notes[0])); }]) {
    const copy = structuredClone(report); mutate(copy);
    assert.throws(() => validateCloudReviewBinding(copy, source), rejected);
  }
  assert.throws(() => validateCloudReviewBinding(report, structuredClone(source)), /unverified-source/);
});

test('index/manifest/file hash disagreement, missing parts and unresolved references fail closed', async () => {
  const { value, files } = await make();
  for (const mutate of [f => { const i = JSON.parse(f.get('index.json')); i.matches[0].content_hash = 'f'.repeat(64); f.set('index.json', JSON.stringify(i)); },
    f => { f.set(`matches/${value.historyKey}/coach.json`, '{}'); }, f => { f.delete([...value.parts.keys()][0]); },
    f => { const i = JSON.parse(f.get('index.json')); i.matches.push(i.matches[0]); f.set('index.json', JSON.stringify(i)); }]) {
    const copy = new Map(files); mutate(copy);
    assert.throws(() => readPublishedReviewSource({ files: copy, matchId: value.summary.match_id, revision: REVISION }), rejected);
  }
  const broken = structuredClone(value);
  broken.coach.games[0].states.S1 = { $ref: { file: 'matches/elsewhere/parts/part-0001.json', key: 'missing' } };
  const raw = serializeCoachJson(broken.coach);
  broken.manifest.files['coach.json'] = { bytes: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex') };
  broken.contentHash = createHash('sha256').update(serializeCoachJson(broken.manifest.files)).digest('hex'); broken.manifest.content_hash = broken.contentHash;
  assert.throws(() => readPublishedReviewSource({ files: filesForBundle(broken), matchId: broken.summary.match_id, revision: REVISION }), /unresolved-source/);
});

test('private and face-down identities never certify English card chips', () => {
  for (const hidden of [{ hidden: true }, { is_face_down: true }, { face_down: true }, { visibility: 'private' }, { visibility: 'face_down' }, { visibility: 'post_game' }]) {
    const card = { name: 'Island', ...hidden };
    const snapshot = { players: { me: { hand: [card], battlefield: [card] }, opponent: { hand: [{ name: 'Forest' }], battlefield: [card] } }, stack: [card] };
    assert.equal(visibleCardNames(snapshot).size, 0);
  }
});
