import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoachBundle } from '../src/coach-bundle.mjs';
import { readPublishedReviewSource } from '../src/review/cloud-review.mjs';
import { verifyCloudReviewLocal } from '../src/review/cloud-review-compute.mjs';
import { prepareHistoricalReplayCopy } from '../src/review/historical-replay-copy.mjs';
import { bundle, filesForBundle, reportForSource } from './helpers/cloud-review-fixture.mjs';

const aliases = [{ arena_id: 1, local_name: '树林', published_name: 'Forest' }];
const counterAliases = [{ type: 7, local_name: '忠诚', published_name: 'Loyalty' }];
async function fixture({ ability = false, second = false, nonCardNames = false } = {}) {
  let replay;
  const initial = await bundle({ richer: true, onReplay: value => { replay = value; } });
  const g = replay.games[0];
  g.steps[0].event.sequence = 110; g.steps[0].event.anchor = g.steps[0].anchor;
  g.steps[1].event.sequence = 111; g.steps[1].event.anchor = g.steps[1].anchor;
  g.states.S1.players.me.battlefield[0].counters = [{ type: 7, name: 'Loyalty', count: 2 }];
  g.turns = [{ turn_number: 1, active_player: 'me', events: [g.steps[0].event, g.steps[1].event] }];
  if (ability) g.states.S1.stack.push({ arena_id: 1, name: 'Forest — ability', instance_id: 102,
    visibility: 'public', is_ability: true, ability_source: { arena_id: 1, name: 'Forest', instance_id: 101, visibility: 'public' } });
  if (second) replay.games.push({ ...structuredClone(g), game_number: 2 });
  if (nonCardNames) {
    replay.match.player = '树林';
    replay.coachNotes = [{ anchor: 'T1-A1', text: '树林', name: '树林', arena_id: 1 }];
  }
  const value = await buildCoachBundle(replay, { cards: initial.cards, multipart: true });
  const source = readPublishedReviewSource({ files: filesForBundle(value), matchId: value.summary.match_id, revision: 'a'.repeat(40) });
  const report = reportForSource(source), local = JSON.parse(JSON.stringify(replay));
  function localize(v) {
    if (!v || typeof v !== 'object') return;
    if (v.arena_id === 1 && v.name === 'Forest') v.name = '树林';
    if (v.arena_id === 1 && v.name === 'Forest — ability') v.name = '树林 — ability';
    if (v.type === 7 && v.name === 'Loyalty') v.name = '忠诚';
    if (Object.hasOwn(v, 'sequence')) v.sequence -= 100;
    for (const child of Object.values(v)) localize(child);
  }
  localize(local);
  return { replay: local, original: replay, source, report, cardAliases: aliases, counterAliases,
    metadata: { cards: source.cards, history_key: source.history_key, content_hash: source.content_hash } };
}

test('explicit copy restores typed aliases and a uniform event offset; strict reader is unchanged', async () => {
  const h = await fixture(), before = JSON.stringify(h.replay);
  assert.equal((await verifyCloudReviewLocal({ replay: h.replay, report: h.report, sourceMetadata: h.metadata })).status, 'stale');
  const result = await prepareHistoricalReplayCopy(h);
  assert.equal(result.receipt.sequence_offset, 100);
  assert.ok(result.receipt.changed_card_names > 0);
  assert.ok(result.receipt.changed_counter_names > 0);
  assert.equal(result.receipt.changed_sequences, 4);
  assert.equal(JSON.stringify(h.replay), before);
  assert.equal((await verifyCloudReviewLocal({ replay: result.replay, report: h.report, sourceMetadata: h.metadata })).status, 'ready');
});

test('exact source returns a separate copy without changing identity or notes', async () => {
  const h = await fixture(); h.replay = h.original;
  const result = await prepareHistoricalReplayCopy(h);
  assert.notEqual(result.replay, h.replay); assert.deepEqual(result.replay, h.replay);
  assert.equal(result.receipt.changed_card_names, 0);
});

test('an opaque verified source, current report binding and explicit aliases are required', async () => {
  const h = await fixture();
  await assert.rejects(prepareHistoricalReplayCopy({ ...h, source: structuredClone(h.source) }), /unverified-source/);
  await assert.rejects(prepareHistoricalReplayCopy({ ...h, report: { ...h.report, source_content_hash: 'f'.repeat(64) } }), /historical-source-stale/);
  await assert.rejects(prepareHistoricalReplayCopy({ ...h, cardAliases: [] }), /historical-exact-hash/);
  await assert.rejects(prepareHistoricalReplayCopy({ ...h, cardAliases: [...aliases, ...aliases] }), /ambiguous-alias/);
  await assert.rejects(prepareHistoricalReplayCopy({ ...h, counterAliases: [{ ...counterAliases[0], type: 1 }] }), /counter-alias/);
});

for (const [name, mutate] of [
  ['single sequence differs', r => { r.games[0].steps[1].event.sequence++; }],
  ['turn event differs', r => { r.games[0].turns[0].events[0].sequence++; }],
  ['sequence missing', r => { delete r.games[0].steps[0].event.sequence; }],
  ['sequence wrong type', r => { r.games[0].steps[0].event.sequence = '10'; }],
  ['life changes', r => { r.games[0].states.S1.players.me.life--; }],
  ['Arena ID changes', r => { r.games[0].states.S1.players.me.battlefield[0].arena_id = 2; }],
  ['counter count changes', r => { r.games[0].states.S1.players.me.battlefield[0].counters[0].count++; }],
  ['counter ID changes', r => { r.games[0].states.S1.players.me.battlefield[0].counters[0].type = 1; }],
  ['arbitrary name', r => { r.games[0].states.S1.players.me.battlefield[0].name = '任意其他名字'; }],
  ['hidden card', r => { r.games[0].states.S1.players.me.battlefield[0].hidden = true; }],
  ['face-down card', r => { r.games[0].states.S1.players.me.battlefield[0].face_down = true; }],
  ['deck quantity changes', r => { r.deck[0].quantity--; }],
  ['hand changes', r => { r.games[0].states.S1.players.me.hand.push({ arena_id: 1, name: '树林' }); }],
  ['frame changes', r => { r.games[0].steps[0].state_id = 'S2'; }],
  ['anchor changes', r => { r.games[0].steps[0].anchor = 'T1-A9'; }],
  ['order changes', r => { r.games[0].steps.reverse(); }],
  ['another game added', r => { r.games.push({ ...structuredClone(r.games[0]), game_number: 2 }); }],
  ['historical note changes', r => { r.coachNotes = [{ anchor: 'T1-A1', text: '新增历史笔记' }]; }],
  ['player name changes', r => { r.match.player = '树林'; }],
]) test(`copy rejects ${name}`, async () => {
  const h = await fixture(); mutate(h.replay); const before = JSON.stringify(h.replay);
  await assert.rejects(prepareHistoricalReplayCopy(h));
  assert.equal(JSON.stringify(h.replay), before);
});

test('privacy failure is not swallowed by the compatibility attempt', async () => {
  const h = await fixture(); h.replay.games[0].states.S1.players.me.battlefield[0].name = 'ghp_' + 'SyntheticSecret'.repeat(3);
  await assert.rejects(prepareHistoricalReplayCopy(h), error => error.code === 'MTGA_SYNC_SECURITY');
});

test('ability name requires the same visible source identity and exact suffix', async () => {
  const h = await fixture({ ability: true });
  const copy = await prepareHistoricalReplayCopy(h);
  assert.equal(copy.replay.games[0].states.S1.stack[0].name, 'Forest — ability');
  assert.equal(copy.replay.games[0].states.S1.stack[0].ability_source.name, 'Forest');
});
for (const [name, mutate] of [
  ['wrong source ID', a => { a.ability_source.arena_id = 2; }],
  ['wrong source name', a => { a.ability_source.name = '其他'; }],
  ['missing suffix', a => { a.name = '树林'; }],
  ['hidden source', a => { a.ability_source.hidden = true; }],
]) test(`ability rejects ${name}`, async () => {
  const h = await fixture({ ability: true }); mutate(h.replay.games[0].states.S1.stack[0]);
  await assert.rejects(prepareHistoricalReplayCopy(h));
});
test('an existing second game remains bound to the complete historical hash', async () => {
  const h = await fixture({ second: true });
  assert.equal((await prepareHistoricalReplayCopy(h)).receipt.exact_bundle_hash_verified, true);
  h.replay.games[1].states.S1.players.me.life--;
  await assert.rejects(prepareHistoricalReplayCopy(h), /historical-exact-hash/);
});
test('matching alias text outside typed card slots is preserved verbatim', async () => {
  const h = await fixture({ nonCardNames: true }), result = await prepareHistoricalReplayCopy(h);
  assert.equal(result.replay.match.player, '树林');
  assert.deepEqual(result.replay.coachNotes, h.replay.coachNotes);
});
