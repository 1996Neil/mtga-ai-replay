import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalDraftDeck, draftDeckChanges, draftDeckVersions, draftDeckCategory, draftManaValue,
  draftSelectionFinished, validateDraftRecommendation, readDraftDeckComparison } from '../src/review/draft-decks.mjs';
import { draftReviewFingerprint } from '../src/review/draft-review.mjs';
import { projectDraftCaptures } from '../src/draft-capture.mjs';
import { startReplayServer } from '../src/server.mjs';

const account = 'a'.repeat(64), runId = 'b'.repeat(32);
const a = { arena_id: 1, name: 'Synthetic Creature', quantity: 1 };
const b = { arena_id: 2, name: 'Synthetic Instant', quantity: 1 };
const c = { arena_id: 3, name: 'Synthetic Enchantment', quantity: 1 };
const island = { arena_id: 4, name: 'Island', quantity: 37 };
const cards = [a, b, c, island];
const metadata = new Map([
  [1, { name: a.name, mana_cost: '{1}{U} // {2}{U}', type_line: 'Artifact Creature — Construct // Sorcery',
    card_faces: [{ name: a.name, mana_cost: '{1}{U}', type_line: 'Artifact Creature — Construct' },
      { name: 'Synthetic Prepare Spell', mana_cost: '{2}{U}', type_line: 'Sorcery' }] }],
  [2, { name: b.name, mana_cost: '{U}', type_line: 'Instant' }],
  [3, { name: c.name, mana_cost: '{2}{U}', type_line: 'Enchantment' }],
  [4, { name: 'Island', mana_cost: '', type_line: 'Basic Land — Island' }],
  [5, { name: 'Island', mana_cost: '', type_line: 'Basic Land — Island' }],
]);
function fixture() {
  const run = { run_id: runId, account_key: account, event_id: 'QuickDraft_SYNTHETIC',
    binding: 'matched_pool', binding_account_status: 'matched',
    matches: ['m1', 'm2', 'm3'].map((id, i) => ({ id, started_at: `2026-10-30T0${i}:00:00.000Z`, result: i === 1 ? 'Loss' : 'Win' })),
    picks: [a, b, c].map((card, i) => ({ pack_number: i + 1, pick_number: 1,
      candidates: [card], selected: card, pool_before: [a, b, c].slice(0, i),
      pool_after: [a, b, c].slice(0, i + 1), complete: true })) };
  const recommendation = { schema: 'MTGA_DRAFT_DECK_RECOMMENDATION_V1',
    run_id: runId, account_key: account, event_id: run.event_id,
    source_fingerprint: draftReviewFingerprint(run), generated_at: '2026-10-30T10:00:00.000Z',
    title: '合成推荐', plan: '合成测试用途。', choices: [{ title: '合成取舍', reason: '合成理由。' }], cards };
  return { run, recommendation };
}
test('version history merges consecutive equal decks and retains A to B to A, quantity changes and gaps', () => {
  const matches = [
    { id: 'm1', started_at: '2026-01-01', deck: cards, result: 'Win' },
    { id: 'm2', started_at: '2026-01-02', deck: [...cards].reverse(), result: 'Loss' },
    { id: 'm3', started_at: '2026-01-03', deck: [b, c, { ...island, quantity: 38 }], result: 'Win' },
    { id: 'm4', started_at: '2026-01-04', deck: [a, b, c, { ...island, arena_id: 5 }], result: 'Win' },
  ];
  const versions = draftDeckVersions(matches);
  assert.equal(versions.length, 3);
  assert.equal(versions[0].matches.length, 2);
  assert.equal(versions[0].wins, 1); assert.equal(versions[0].losses, 1);
  assert.equal(versions[2].fingerprint, versions[0].fingerprint);
  assert.equal(versions[1].changes_from_previous.added[0].quantity, 1);
  assert.equal(versions[1].changes_from_previous.removed[0].name, a.name);
  assert.equal(draftDeckVersions([matches[0], { id: 'gap', started_at: '2026-01-02', deck: null }, matches[3]]).length, 2);
  assert.equal(canonicalDraftDeck([{ ...a, quantity: 1 }, { ...a, quantity: 2 }])[0].quantity, 3);
});
test('comparison reports exact quantities and ignores basic-land printings', () => {
  assert.deepEqual(draftDeckChanges(cards, [a, b, c, { ...island, arena_id: 5 }]), { added: [], removed: [] });
  const changes = draftDeckChanges([a, { ...b, quantity: 2 }, c, island], [a, b, { ...c, quantity: 2 }, island]);
  assert.equal(changes.added[0].quantity, 1); assert.equal(changes.added[0].name, c.name);
  assert.equal(changes.removed[0].quantity, 1); assert.equal(changes.removed[0].name, b.name);
  assert.throws(() => canonicalDraftDeck([{ ...a, quantity: -1 }]));
});
test('card types and hybrid costs use creature face and never misclassify artifact creatures', () => {
  assert.equal(draftDeckCategory('Artifact Creature — Sphinx'), 'creature');
  assert.equal(draftDeckCategory('神器生物 — 史芬斯'), 'creature');
  assert.equal(draftDeckCategory('Legendary Planeswalker — Jace'), 'planeswalker');
  assert.equal(draftDeckCategory('基本地 — Swamp'), 'land');
  assert.equal(draftManaValue('{1}{U/B}'), 2); assert.equal(draftManaValue('{2/U}{G}'), 3);
  assert.equal(draftManaValue('{X}{B}{B}'), 2); assert.equal(draftManaValue(''), 0);
  assert.equal(draftManaValue(null), null);
  assert.equal(draftManaValue('{1}{U} // {2}{U}'), null);
});
test('recommendation is exactly 40 cards from the complete pool with independently identified basic lands', () => {
  const { run, recommendation } = fixture();
  assert.equal(draftSelectionFinished(run), true);
  assert.equal(validateDraftRecommendation(recommendation, run, metadata).status, 'ready');
  for (const modify of [
    value => { value.cards = [a, b, c, { ...island, quantity: 36 }]; },
    value => { value.cards = [{ ...a, quantity: 2 }, b, c, { ...island, quantity: 36 }]; },
    value => { value.cards = [{ ...a, name: 'Island', quantity: 38 }, b, c]; },
    value => { value.account_key = 'c'.repeat(64); },
    value => { value.extra = 'unapproved'; },
  ]) {
    const changed = structuredClone(recommendation); modify(changed);
    assert.throws(() => validateDraftRecommendation(changed, run, metadata));
  }
  const changed = structuredClone(run); changed.picks[0].candidates.push(b);
  assert.equal(validateDraftRecommendation(recommendation, changed, metadata).status, 'stale');
  assert.equal(draftSelectionFinished({ ...run, picks: run.picks.slice(0, 2) }), false);
});
test('read-only deck extraction supports all observed versions and preserves actual history when recommendation is damaged', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mtga-draft-decks-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { run, recommendation } = fixture();
  const db = new DatabaseSync(join(dataDir, 'replays.sqlite3'));
  db.exec('CREATE TABLE replays(match_id TEXT PRIMARY KEY, started_at TEXT, summary_json TEXT, replay_json TEXT); CREATE TABLE cards(arena_id INTEGER PRIMARY KEY,name TEXT,metadata_json TEXT)');
  for (const [id, info] of metadata) db.prepare('INSERT INTO cards VALUES(?,?,?)').run(id, info.name, JSON.stringify(info));
  for (const [i, match] of run.matches.entries()) {
    const deck = i === 1 ? [b, c, { ...island, quantity: 38 }] : cards;
    db.prepare('INSERT INTO replays VALUES(?,?,?,?)').run(match.id, match.started_at,
      JSON.stringify({ account_key: account, result: match.result }), JSON.stringify({ deck }));
  }
  db.close();
  const directory = join(dataDir, 'draft-decks', account), path = join(directory, `${runId}.json`);
  await mkdir(directory, { recursive: true }); await writeFile(path, JSON.stringify(recommendation));
  const result = await readDraftDeckComparison(run, { dataDir, accountKey: account });
  assert.equal(result.versions.length, 3);
  assert.equal(result.recommendation_status, 'ready');
  assert.equal(result.recommendation.cards.reduce((sum, card) => sum + card.quantity, 0), 40);
  assert.equal(result.recommendation.cards.find(card => card.arena_id === 1).mana_value, 2);
  assert.equal(result.recommendation.cards.find(card => card.arena_id === 1).category, 'creature');
  assert.equal(result.versions[1].comparison.added[0].name, a.name);
  assert.equal(result.versions[1].comparison.removed[0].quantity, 1);
  await writeFile(path, '{"broken":');
  const broken = await readDraftDeckComparison(run, { dataDir, accountKey: account });
  assert.equal(broken.recommendation_status, 'error'); assert.equal(broken.versions.length, 3);
  await rm(path); await symlink(join(dataDir, 'outside.json'), path);
  assert.equal((await readDraftDeckComparison(run, { dataDir, accountKey: account })).recommendation_status, 'error');
  await assert.rejects(readDraftDeckComparison(run, { dataDir, accountKey: 'c'.repeat(64) }));
  const otherAccount = { ...run, binding_account_status: 'conflict' };
  assert.equal((await readDraftDeckComparison(otherAccount, { dataDir, accountKey: account })).versions.length, 0);
  const edit = new DatabaseSync(join(dataDir, 'replays.sqlite3'));
  edit.prepare('UPDATE replays SET summary_json=? WHERE match_id=?').run(JSON.stringify({ account_key: 'c'.repeat(64), result: 'Loss' }), 'm2');
  edit.close();
  const scoped = await readDraftDeckComparison(run, { dataDir, accountKey: account });
  assert.ok(scoped.versions.every(version => version.matches.every(match => match.id !== 'm2')));
});
test('HTTP deck comparison is scoped to an actual observed draft and current account', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mtga-draft-deck-http-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const viewerDir = join(dataDir, 'viewer');
  await mkdir(viewerDir); await writeFile(join(viewerDir, 'index.html'), '<title>Synthetic</title>');
  const observations = [a, b, c].flatMap((card, i) => ['pack', 'pick'].map((kind, j) => ({
    observation_id: String(i * 2 + j + 1).padStart(64, '0'), account_key: account,
    event_id: 'QuickDraft_SYNTHETIC', kind, pack_number: i + 1, pick_number: 1,
    card_ids: [card.arena_id], logged_at: '2026-10-30T10:00:00.000+08:00',
  })));
  const db = new DatabaseSync(join(dataDir, 'draft-capture.sqlite3'));
  db.exec('CREATE TABLE observations(seq INTEGER PRIMARY KEY,observation_id TEXT,body TEXT); CREATE TABLE gaps(gap_id TEXT); CREATE TABLE accounts(account_key TEXT,label TEXT); CREATE TABLE meta(key TEXT,value TEXT)');
  observations.forEach((row, i) => db.prepare('INSERT INTO observations VALUES(?,?,?)').run(i + 1, row.observation_id, JSON.stringify(row)));
  db.close();
  await mkdir(join(dataDir, 'draft-sync'));
  await writeFile(join(dataDir, 'draft-sync/published.json'), JSON.stringify({ verified: true, revision: 'a'.repeat(40), observation_ids: observations.map(row => row.observation_id) }));
  const [run] = projectDraftCaptures(observations);
  const { recommendation } = fixture();
  recommendation.run_id = run.run_id; recommendation.source_fingerprint = draftReviewFingerprint(run);
  await mkdir(join(dataDir, 'draft-decks', account), { recursive: true });
  await writeFile(join(dataDir, 'draft-decks', account, `${run.run_id}.json`), JSON.stringify(recommendation));
  await mkdir(join(dataDir, 'cards'));
  for (const [id, card] of metadata) await writeFile(join(dataDir, 'cards', `${id}.json`), JSON.stringify(card));
  const server = await startReplayServer({ dataDir, viewerDir, observeLocalLogs: false, displayNamesZh: new Map(), cardNames: new Map([[1, a.name], [2, b.name], [3, c.name]]) });
  t.after(() => server.close());
  const path = `api/draft-runs/${run.run_id}/decks`;
  assert.equal((await fetch(server.url + path)).status, 400);
  assert.equal((await fetch(`${server.url}${path}?account=${'c'.repeat(64)}`)).status, 404);
  assert.equal((await fetch(`${server.url}${path}?account=${account}&extra=1`)).status, 400);
  const response = await fetch(`${server.url}${path}?account=${account}`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.recommendation_status, 'ready'); assert.equal(result.recommendation.cards.reduce((sum, card) => sum + card.quantity, 0), 40);
  assert.equal((await fetch(`${server.url}${path}?account=${account}`, { method: 'POST' })).status, 405);
});
