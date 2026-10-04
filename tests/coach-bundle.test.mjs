import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildCoachBundle, resolveCoachBundle, serializeCoachJson } from '../src/coach-bundle.mjs';
import { validateBundleFiles } from '../src/sync-security.mjs';

const card = (id, name, extra = {}) => ({ arena_id: id, name, instance_id: id + 100, logical_id: `C${id}`, visibility: 'public',
  card_types: ['Creature'], is_tapped: false, counters: [], is_attacking: false, is_blocking: false, blocked_attacker_ids: [], attachments: [], targets: [], ...extra });
const player = (name, hand = [], battlefield = []) => ({ name, life: 20, hand, handSize: hand.length, librarySize: 30, battlefield, graveyard: [], exile: [] });
const state = (id, turn, me, opponent, stack = []) => ({ gameStateId: id, turn, phase: 'Phase_Combat', step: 'Step_DeclareBlock', activePlayer: 'opponent', priorityPlayer: 'me', players: { me, opponent }, stack, warnings: [] });
function fixture() {
  const forest = card(1, 'Forest', { card_types: ['Land'] });
  const moose = card(2, 'Galewind Moose', { visibility: 'player_known', power: 6, toughness: 6 });
  const attacker = card(3, 'Soaring Stoneglider', { is_attacking: true, attacking_target_id: 1, power: 2, toughness: 3 });
  const future = card(4, 'Future Revealed Spell');
  const s0 = state(1, 0, player('Arena Me', [moose], [forest]), player('Arena Opp', [card(999, 'Hidden Future Secret')], []));
  const s1 = state(2, 18, player('Arena Me', [moose], [forest]), player('Arena Opp', [], [attacker]));
  const s2 = state(3, 18, player('Arena Me', [], [forest]), player('Arena Opp', [], [attacker]), [{ ...moose, visibility: 'public', targets: [attacker] }]);
  const s3 = state(4, 18, player('Arena Me', [], [forest, { ...moose, visibility: 'public', is_blocking: true, blocked_attacker_ids: [attacker.instance_id] }]), player('Arena Opp', [], [attacker]), [future]);
  const s4 = state(5, 19, player('Arena Me', [], [forest, moose]), player('Arena Opp', [future], []));
  const event = (type, actor, value, extra = {}) => ({ type, actor, card: value, ...extra });
  return { schema_version: '1.0', perspective: { policy: 'Player perspective', hidden_information: 'omitted', post_game_reveals: 'omitted' },
    match: { id: 'fixture-full-match-id', started_at: '2026-10-01T15:25:02.767Z', event: 'Jump In', is_jump_in: true, result: 'Win', on_play: true, player: 'Arena Me', opponent: 'Arena Opp', internal_auth_id: 'private account id', token: 'secret', source_path: '/Users/private/Player.log' },
    deck: [{ arena_id: 1, name: 'Forest', quantity: 39 }, { arena_id: 2, name: 'Galewind Moose', quantity: 1 }],
    raw_logs: '/Users/private/Player.log', games: [{ game_number: 1, on_play: true, starting_hand: [moose], mulligans: { me: 1, opponent: 0 }, decision_points: [{ type: 'mulligan', candidate_only: true, initial_hand: [forest, moose] }],
      states: { S0: s0, S1: s1, S2: s2, S3: s3, S4: s4 }, steps: [
        { anchor: 'T0-A1', turn: 0, action: 1, state_id: 'S0', event: { type: 'mulligan_state', actor: 'me' } },
        { anchor: 'T18-A1', turn: 18, action: 1, before_state_id: 'S1', state_id: 'S2', event: event('cast', 'me', moose) },
        { anchor: 'T18-A2', turn: 18, action: 2, before_state_id: 'S2', state_id: 'S3', event: event('block', 'me', moose, { targets: [attacker] }) },
        { anchor: 'T18-A3', turn: 18, action: 3, before_state_id: 'S2', state_id: 'S3', event: event('cast', 'opponent', future) },
        { anchor: 'T19-A1', turn: 19, action: 1, before_state_id: 'S3', state_id: 'S4', event: event('return', 'opponent', future, { from: 'Stack', to: 'Hand' }) },
      ], turns: [{ turn_number: 18, active_player: 'opponent', events: [event('draw', 'opponent', card(999, 'Hidden Future Secret'), { details: 'Hidden Future Secret', targets: [card(999, 'Hidden Future Secret')] })], decision_points: [] }],
      result: { outcome: 'Win', reason: 'unknown', life: { me: 9, opponent: -1 } }, warnings: [], evidence: { parser: 'mtga-log-parser@4.1.0' } }], warnings: [], coachNotes: [{ anchor: 'T18-A2', text: 'Flash block review', game_number: 1 }] };
}
const rules = [
  { arena_id: 1, name: 'Forest', display_name_zh: '树林', mana_cost: '', type_line: 'Basic Land — Forest', oracle_text: '{T}: Add {G}.', keywords: [], source: 'local', metadata_complete: true },
  { arena_id: 2, name: 'Galewind Moose', display_name_zh: '烈风驼鹿', mana_cost: '{4}{G}{G}', type_line: 'Creature — Elk', oracle_text: 'Flash\nReach\nTrample', keywords: ['Flash', 'Reach', 'Trample'], power: '6', toughness: '6', source: 'local', metadata_complete: true },
  { arena_id: 3, name: 'Soaring Stoneglider', type_line: 'Creature', oracle_text: 'Flying', keywords: ['Flying'], metadata_complete: true },
  { arena_id: 4, name: 'Future Revealed Spell', oracle_text: 'Draw a card.', keywords: [], metadata_complete: true },
  { arena_id: 999, name: 'Hidden Future Secret', oracle_text: 'Must never be exported.', image_url: '/Users/private/cards.png' },
];
const options = { cards: rules, generatedAt: '2026-10-02T00:00:00Z' };

test('full bundle retains canonical gameplay, all own hands/deck/opening and bilingual static rules', async () => {
  const raw = fixture(), original = structuredClone(raw), result = await buildCoachBundle(raw, options);
  assert.deepEqual(raw, original);
  assert.equal(result.summary.deck_cards, 40); assert.equal(result.summary.actions, 5);
  assert.equal(result.coach.match.player, 'Arena Me'); assert.equal(result.coach.match.opponent, 'Arena Opp');
  assert.equal(result.coach.deck[1].name, 'Galewind Moose'); assert.equal(result.coach.deck[1].display_name_zh, '烈风驼鹿');
  const game = result.coach.games[0];
  assert.equal(Object.keys(game.states).length, 5);
  assert.equal(game.states.S1.players.me.hand[0].name, 'Galewind Moose');
  assert.deepEqual(game.states.S2.players.me.hand, []);
  assert.equal(game.starting_hand[0].name, 'Galewind Moose'); assert.equal(game.mulligans.me, 1);
  assert.equal(game.decision_points[0].initial_hand.length, 2); assert.equal(game.opening.bottomed_cards, null);
  assert.equal(result.cards.find(c => c.arena_id === 2).oracle_text, 'Flash\nReach\nTrample');
  assert.doesNotMatch(JSON.stringify(result), /Hidden Future Secret|999|private account id|\/Users\/|image_url|raw_logs|internal_auth_id/);
});

test('known opponent information is chronological and never asserts a returned hidden-hand identity', async () => {
  const { coach } = await buildCoachBundle(fixture(), options); const s = coach.games[0].states;
  assert.doesNotMatch(JSON.stringify(s.S0), /Future Revealed Spell|Hidden Future Secret/);
  assert.doesNotMatch(JSON.stringify(s.S1), /Future Revealed Spell/);
  assert.equal(s.S3.known_opponent_information.known_opponent_cards.find(c => c.arena_id === 4).first_revealed_anchor, 'T18-A3');
  const known = s.S4.known_opponent_information.known_opponent_cards.find(c => c.arena_id === 4);
  assert.equal(known.currently_hidden, true); assert.equal(known.current_hidden_hand_identity_confirmed, false);
  assert.equal(known.last_observed_transition.to, 'Hand'); assert.equal(known.current_public_location, null);
  assert.deepEqual(s.S4.players.opponent.hand, []);
  assert.ok(coach.games[0].turns[0].events[0].amount == null); assert.equal(coach.games[0].turns[0].events[0].card, undefined);
  assert.equal(coach.games[0].turns[0].events[0].details, undefined);
});

test('pooled before/after refs, shared frame, combat, stack target and mana sources are preserved without legality claims', async () => {
  const { coach } = await buildCoachBundle(fixture(), options); const game = coach.games[0];
  assert.equal(game.steps[1].before_state_id, 'S1'); assert.equal(game.steps[1].after_state_id, 'S2');
  assert.equal(game.steps[2].state_id, game.steps[3].state_id); assert.equal(game.steps[2].grouped_frame, true);
  assert.equal(game.steps[2].state_boundary, 'shared_GRE_frame'); assert.match(game.warnings.join(' '), /intermediate board state was not observed/);
  assert.equal(game.states.S3.combat.attackers[0].blockers[0].name, 'Galewind Moose');
  assert.equal(game.states.S3.combat.attackers[0].defending.player, 'me');
  assert.equal(game.states.S2.stack[0].targets[0].name, 'Soaring Stoneglider');
  assert.equal(game.states.S1.mana_sources.me[0].name, 'Forest'); assert.equal(game.states.S1.mana_sources.me[0].usable_now, null);
  assert.equal(game.states.S1.mana_sources.available_mana, null); assert.equal(game.states.S1.priority.source, 'last_observed');
  assert.equal(game.steps[1].certainty.legality, 'not_evaluated');
});

test('manifest hashes actual pretty files, content hash ignores generated time, history key uses full match id and start', async () => {
  const first = await buildCoachBundle(fixture(), options), second = await buildCoachBundle(fixture(), { ...options, generatedAt: '2030-01-01T00:00:00Z' });
  assert.equal(first.contentHash, second.contentHash); assert.notEqual(first.manifest.generated_at, second.manifest.generated_at);
  for (const [file, value] of [['summary.json', first.summary], ['coach.json', first.coach], ['cards.json', first.cards]]) {
    const text = serializeCoachJson(value), digest = createHash('sha256').update(text).digest('hex');
    assert.equal(first.manifest.files[file].sha256, digest); assert.equal(first.manifest.files[file].bytes, Buffer.byteLength(text));
  }
  assert.match(first.historyKey, /fixture-full-match-id/); assert.match(first.historyKey, /2026-10-01T15-25-02-767Z/);
  const other = fixture(); other.match.id = 'fixture-full-match-other-id';
  assert.notEqual((await buildCoachBundle(other, options)).historyKey, first.historyKey);
});

test('reader index identifies exact action and before/after JSON line ranges for every game', async () => {
  const raw = fixture(); raw.games.push({ ...structuredClone(raw.games[0]), game_number: 2 });
  const { coach, manifest } = await buildCoachBundle(raw, options), lines = serializeCoachJson(coach).trimEnd().split('\n');
  assert.equal(coach.games.length, 2); assert.equal(manifest.reader_index.games.length, 2);
  for (let index = 0; index < 2; index++) {
    const entry = manifest.reader_index.games[index].anchors['T18-A1'];
    const slice = range => lines.slice(range.start_line - 1, range.end_line).join('\n');
    assert.match(slice(entry.action), /"anchor": "T18-A1"/);
    assert.match(slice(entry.before), /"S1": \{/); assert.match(slice(entry.before), /Galewind Moose/);
    assert.match(slice(entry.after), /"S2": \{/); assert.match(slice(entry.after), /"stack"/);
  }
});

test('explicit hidden and post-game cards/targets never enter states, events or card rules', async () => {
  const raw = fixture(); const secret = card(888, 'Postgame Secret', { visibility: 'post_game_revealed' });
  raw.games[0].states.S1.players.opponent.battlefield.push(secret);
  raw.games[0].steps[1].event.targets = [secret]; raw.games[0].steps[1].event.details = 'Postgame Secret';
  const result = await buildCoachBundle(raw, { ...options, cards: [...rules, { arena_id: 888, name: 'Postgame Secret', oracle_text: 'Secret' }] });
  assert.doesNotMatch(JSON.stringify(result), /Postgame Secret|888/);
  assert.deepEqual(result.coach.games[0].states.S1.players.opponent.battlefield.at(-1), { hidden: true });
});

test('private and face-down opponent identities are omitted from zones, targets and static dictionary', async () => {
  for (const marker of [{ visibility: 'Visibility_Private' }, { is_face_down: true }, { face_down: true }]) {
    const raw = fixture(), secret = card(777, 'Private Facedown Sentinel', marker);
    raw.games[0].states.S1.players.opponent.exile.push(secret);
    raw.games[0].steps[1].event.targets = [secret]; raw.games[0].steps[1].event.details = 'Private Facedown Sentinel';
    const result = await buildCoachBundle(raw, { ...options, cards: [...rules, { arena_id: 777, name: 'Private Facedown Sentinel', oracle_text: 'Hidden' }] });
    assert.doesNotMatch(JSON.stringify(result), /Private Facedown Sentinel|777/);
    assert.deepEqual(result.coach.games[0].states.S1.players.opponent.exile[0], { hidden: true });
  }
});

test('raw Arena seats do not misidentify the defender when the local player occupied seat two', async () => {
  const raw = fixture();
  const attacker = card(6, 'Local Seat Two Attacker', { is_attacking: true, attacking_target_id: 1 });
  raw.games[0].states.S1.players.me.battlefield.push(attacker);
  const { coach } = await buildCoachBundle(raw, options);
  const combat = coach.games[0].states.S1.combat.attackers.find(c => c.instance_id === attacker.instance_id);
  assert.equal(combat.controller, 'me'); assert.equal(combat.defending.player, 'opponent');
  assert.equal(combat.raw_attacking_target_id, 1);
});

test('events lacking logical ids reuse the currently observed entity without duplicating known history or backfilling its first anchor', async () => {
  const raw = fixture(); const { logical_id, ...eventCard } = raw.games[0].steps[3].event.card;
  raw.games[0].steps[3].event.card = eventCard;
  const { coach } = await buildCoachBundle(raw, options), s = coach.games[0].states;
  assert.equal(s.S3.known_opponent_information.known_opponent_cards.filter(c => c.arena_id === 4).length, 1);
  assert.equal(s.S4.known_opponent_information.known_opponent_cards.filter(c => c.arena_id === 4).length, 1);
  const first = s.S1.known_opponent_information.known_opponent_cards.find(c => c.arena_id === 3);
  assert.equal(first.first_revealed_anchor, null);
  assert.equal(s.S4.known_opponent_information.known_opponent_cards.find(c => c.arena_id === 3).first_revealed_anchor, null);
});

test('missing cards cannot be reported complete and stack source/effect/ordering fields survive extraction', async () => {
  const raw = fixture(); Object.assign(raw.games[0].states.S2.stack[0], { is_ability: true,
    ability_source: card(2, 'Galewind Moose'), source: card(2, 'Galewind Moose'), controller: 'me',
    known_effect: 'Observed ability rule text', ability_kind: 'unknown', stack_order: 1 });
  const result = await buildCoachBundle(raw, { ...options, cards: [] });
  assert.equal(result.summary.source_coverage.card_metadata_complete, false);
  const object = result.coach.games[0].states.S2.stack[0];
  assert.equal(object.source.name, 'Galewind Moose'); assert.equal(object.ability_source.name, 'Galewind Moose');
  assert.equal(object.known_effect, 'Observed ability rule text'); assert.equal(object.stack_order, 1);
  assert.equal(object.controller, 'me'); assert.equal(object.stack_type, 'ability');
});

test('raw GRE id resets cannot reorder canonical chronology or backfill later reveals', async () => {
  const raw = fixture(); raw.games[0].states.S3.gameStateId = 0;
  const { coach } = await buildCoachBundle(raw, options);
  assert.doesNotMatch(JSON.stringify(coach.games[0].states.S1), /Future Revealed Spell/);
  assert.ok(coach.games[0].states.S3.known_opponent_information.known_opponent_cards.some(c => c.name === 'Future Revealed Spell'));
});

test('reader index locates whole action timeline, turns, opening and deck without fetching all states', async () => {
  const { coach, manifest } = await buildCoachBundle(fixture(), options), lines = serializeCoachJson(coach).trimEnd().split('\n');
  const index = manifest.reader_index.games[0];
  const slice = range => lines.slice(range.start_line - 1, range.end_line).join('\n');
  assert.match(slice(index.actions), /"steps": \[/); assert.match(slice(index.actions), /T0-A1/); assert.match(slice(index.actions), /T19-A1/);
  assert.doesNotMatch(slice(index.actions), /"states": \{/);
  assert.match(slice(index.turns), /"turns": \[/); assert.match(slice(index.opening), /"opening": \{/);
  assert.match(slice(manifest.reader_index.deck), /"deck": \[/);
});

test('recorded mana pool, uncertainty, summoning sickness, copy and marked damage survive without future backfill', async () => {
  const raw = fixture(); const states = raw.games[0].states;
  Object.assign(states.S0.players.me, { mana_pool: null, mana_pool_source: 'unknown' });
  Object.assign(states.S1.players.me, { mana_pool: [{ color: 'G', amount: 3, source_instance_id: 101 }, { color: null, amount: null, source_instance_id: null }], mana_pool_source: 'last_observed' });
  Object.assign(states.S1.players.opponent, { mana_pool: null, mana_pool_source: 'unknown' });
  Object.assign(states.S1.players.me.battlefield[0], { has_summoning_sickness: true, is_copy: false, damage: 3 });
  const { coach } = await buildCoachBundle(raw, options), result = coach.games[0].states;
  assert.equal(result.S0.players.me.mana_pool, null); assert.equal(result.S0.players.me.mana_pool_source, 'unknown');
  assert.deepEqual(result.S1.players.me.mana_pool, states.S1.players.me.mana_pool);
  assert.equal(result.S1.players.me.mana_pool_source, 'last_observed'); assert.equal(result.S1.players.opponent.mana_pool, null);
  const resource = result.S1.players.me.battlefield[0];
  assert.equal(resource.has_summoning_sickness, true); assert.equal(resource.is_copy, false); assert.equal(resource.damage, 3);
  assert.equal(result.S1.mana_sources.available_mana, null); assert.equal(result.S1.mana_sources.me[0].usable_now, null);
});

test('readable multipart preserves the complete expanded model, stable history and exact file hashes', async () => {
  const raw = fixture(); raw.games.push({ ...structuredClone(raw.games[0]), game_number: 2 });
  const expanded = await buildCoachBundle(raw, { ...options, multipart: false });
  const bundle = await buildCoachBundle(raw, { ...options, multipart: true, partitionBytes: 8192, historyKey: 'published-stable-history' });
  assert.equal(bundle.historyKey, 'published-stable-history'); assert.ok(bundle.parts.size > 1);
  assert.deepEqual(resolveCoachBundle(bundle.coach, bundle.parts), expanded.coach);
  const serialized = new Map([...bundle.parts].map(([file, part]) => [file, serializeCoachJson(part)]));
  assert.deepEqual(resolveCoachBundle(JSON.parse(serializeCoachJson(bundle.coach)), serialized), expanded.coach);
  for (const [file, text] of serialized) {
    assert.match(file, /^matches\/published-stable-history\/parts\/part-\d{4}\.json$/);
    assert.ok(Buffer.byteLength(text) <= 8192);
    assert.equal(bundle.manifest.files[file].bytes, Buffer.byteLength(text));
    assert.equal(bundle.manifest.files[file].sha256, createHash('sha256').update(text).digest('hex'));
    const part = JSON.parse(text); assert.equal(part.schema, 'MTGA_COACH_PART_V1');
    assert.equal(text.trimEnd().split('\n').length, Object.keys(part.records).length + 6);
  }
  const later = await buildCoachBundle(raw, { ...options, generatedAt: '2030-01-01T00:00:00Z', multipart: true, partitionBytes: 8192, historyKey: bundle.historyKey });
  assert.equal(bundle.contentHash, later.contentHash);
  await assert.rejects(buildCoachBundle(raw, { ...options, historyKey: '../outside' }), /Invalid Coach history key/);
});

test('each ordinary anchor board is one complete record at the manifest line range', async () => {
  const expanded = await buildCoachBundle(fixture(), { ...options, multipart: false });
  const bundle = await buildCoachBundle(fixture(), { ...options, multipart: true, partitionBytes: 8192 });
  const files = new Map([...bundle.parts].map(([file, part]) => [file, serializeCoachJson(part).trimEnd().split('\n')]));
  for (const [anchor, entry] of Object.entries(bundle.manifest.reader_index.games[0].anchors)) {
    for (const [boundary, stateId] of [['before', entry.before_state_id], ['after', entry.after_state_id]]) {
      if (!stateId) { assert.equal(entry[boundary], null); continue; }
      const range = entry[boundary]; assert.equal(range.start_line, range.end_line);
      const row = files.get(range.file)[range.start_line - 1];
      const record = JSON.parse(`{${row.trim().replace(/,$/, '')}}`)[range.key];
      assert.deepEqual(record, expanded.coach.games[0].states[stateId], `${anchor} ${boundary}`);
    }
  }
});

test('oversized individual state fields use typed structural chunks and lose no Unicode or chronology', async () => {
  const raw = fixture(); raw.games[0].states.S1.warnings.push('完整中文与😀 '.repeat(5000));
  raw.games[0].states.S1.players.me.battlefield.push(...Array.from({ length: 80 }, (_, i) => card(1000 + i, `Observed token ${i}`, { is_token: true })));
  const expanded = await buildCoachBundle(raw, { ...options, multipart: false });
  const bundle = await buildCoachBundle(raw, { ...options, multipart: true, partitionBytes: 8192 });
  assert.deepEqual(resolveCoachBundle(bundle.coach, bundle.parts), expanded.coach);
  assert.ok([...bundle.parts.values()].every(part => Buffer.byteLength(serializeCoachJson(part)) <= 8192));
  const missing = new Map(bundle.parts); missing.delete(bundle.coach.games[0].states.S1.$ref.file);
  assert.throws(() => resolveCoachBundle(bundle.coach, missing), /Missing Coach part reference/);
});

test('semantic security validation catches a credential across a prospective string chunk boundary', async () => {
  const characters = Math.floor((8192 - 256) / 6);
  const warning = 'a'.repeat(characters - 3) + ' ghp_SYNTHETIC_BOUNDARY_CREDENTIAL ' + 'z'.repeat(12000);
  const first = warning.slice(0, characters), second = warning.slice(characters);
  assert.equal(first.slice(-2), 'gh'); assert.ok(second.startsWith('p_'));
  assert.equal(validateBundleFiles(new Map([['latest/coach.json', JSON.stringify({ warnings: [first, second] })]])).ok, true);
  const raw = fixture(); raw.games[0].states.S1.warnings.push(warning);
  await assert.rejects(buildCoachBundle(raw, { ...options, multipart: true, partitionBytes: 8192 }), error => {
    assert.equal(error.code, 'MTGA_SYNC_SECURITY'); assert.equal(error.rule, 'credential-text');
    assert.doesNotMatch(error.message, /SYNTHETIC_BOUNDARY_CREDENTIAL/); return true;
  });
});
