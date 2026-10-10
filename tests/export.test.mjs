import test from 'node:test';
import assert from 'node:assert/strict';
import { toJSON, toMarkdown } from '../src/export.mjs';

function fixture() {
  return {
    schema_version: '1.0',
    perspective: { policy: 'player at decision time', hidden_information: 'omitted', post_game_reveals: 'omitted' },
    match: { id: 'test-match', started_at: '2026-10-01T12:00:00Z', event_id: 'JumpIn_2026', event: 'Jump In', is_jump_in: true, result: 'Win', on_play: true, player: 'Player', opponent: 'Opponent' },
    deck: [{ name: 'Mountain', arena_id: 1, quantity: 17 }],
    games: [{ game_number: 1, on_play: true, starting_hand: [{ name: 'Mountain', arena_id: 1 }, { name: 'Lightning Bolt', arena_id: 2 }], mulligans: { me: 0, opponent: 1 }, turns: [
      { turn_number: 1, active_player: 'me', events: [
        { sequence: 1, type: 'land_played', actor: 'me', card: { name: 'Mountain', arena_id: 1, instance_id: 100, visibility: 'player_known' } },
        { sequence: 2, type: 'cast', actor: 'me', card: { name: 'Lightning Bolt', arena_id: 2, instance_id: 101, visibility: 'public' }, targets: [{ player: 'opponent' }] },
      ], decision_points: [] },
      { turn_number: 2, active_player: 'opponent', events: [
        { sequence: 3, type: 'draw', actor: 'opponent', amount: 1, card: { name: 'Counterspell', arena_id: 3, instance_id: 200, visibility: 'hidden' }, details: 'Counterspell enters hand' },
        { sequence: 4, type: 'life_changed', actor: 'opponent', amount: -3, life: { me: 20, opponent: 17 } },
      ], decision_points: [] },
      { turn_number: 3, active_player: 'me', events: [
        { sequence: 5, type: 'draw', actor: 'me', card: { name: 'Mountain', arena_id: 1, instance_id: 102, visibility: 'player_known' } },
        { sequence: 6, type: 'new_mechanic', actor: 'me', card: { name: 'Goblin', arena_id: 4, instance_id: 103, visibility: 'public' }, amount: 2, details: 'Observed effect' },
      ], decision_points: ['Mulligan'] },
    ], result: { outcome: 'Win', reason: 'life total', life: { me: 6, opponent: 0 } }, warnings: [] }],
    warnings: [],
  };
}

test('Markdown includes match, opening, chronological actions, result and compact deck', () => {
  const md = toMarkdown(fixture());
  assert.match(md, /^# MTGA Replay\n/);
  assert.match(md, /Event: Jump In \(JumpIn/);
  assert.match(md, /On the play: Yes/);
  assert.match(md, /Mountain; Lightning Bolt/);
  assert.match(md, /Mulligans — Me: 0; Opponent: 1/);
  assert.match(md, /Me played land: Mountain #100/);
  assert.match(md, /Me cast Lightning Bolt #101 → Opponent/);
  assert.match(md, /Opponent drew 1 card/);
  assert.match(md, /Me drew Mountain #102/);
  assert.match(md, /Final life: Me 6; Opponent 0/);
  assert.match(md, /17× Mountain/);
  assert.match(md, /available to Me at that moment/);
});

test('Arena turn headers preserve the global sequence and include generic event fallback', () => {
  const md = toMarkdown(fixture());
  assert.match(md, /Arena Turn 1 — Me/);
  assert.match(md, /Arena Turn 2 — Opponent/);
  assert.match(md, /Arena Turn 3 — Me/);
  assert.match(md, /new\\_mechanic — Goblin #103 \(2\): Observed effect/);
  assert.match(md, /\[Decision Point candidate\] Mulligan/);
});

test('JSON remains structured, pretty, and does not mutate canonical input', () => {
  const original = fixture();
  const before = structuredClone(original);
  const encoded = toJSON(original);
  const parsed = JSON.parse(encoded);
  assert.match(encoded, /\n  "schema_version": "1.0"/);
  assert.equal(parsed.games[0].turns[2].events[0].card.name, 'Mountain');
  assert.equal(parsed.games[0].result.life.me, 6);
  assert.deepEqual(original, before);
});

test('both exports redact hidden opponent identities, IDs, details and post-game reveals', () => {
  const replay = fixture();
  replay.games[0].turns[1].events.push({ sequence: 7, type: 'reveal', actor: 'opponent', card: { name: 'Secret Postgame Card', arena_id: 99999, instance_id: 99888, visibility: 'post-game-revealed' }, details: 'Secret Postgame Card was held' });
  replay.games[0].turns[0].events[1].targets.push({ name: 'Hidden Target', arena_id: 77777, instance_id: 77666, visibility: 'hidden' });
  for (const output of [toMarkdown(replay), toJSON(replay)]) {
    assert.doesNotMatch(output, /Counterspell|Secret Postgame Card|Hidden Target|99999|99888|77777|77666/);
  }
  const event = JSON.parse(toJSON(replay)).games[0].turns[1].events[0];
  assert.equal(event.card, undefined);
  assert.equal(event.details, undefined);
  assert.equal(event.amount, 1);
});

test('opponent draws stay count-only while later public reveals appear chronologically', () => {
  const replay = fixture();
  replay.games[0].turns[1].events[0].card.visibility = 'public';
  replay.games[0].turns[2].events.push({ sequence: 8, type: 'reveal', actor: 'opponent', card: { name: 'Counterspell', arena_id: 3, instance_id: 201, visibility: 'public' } });
  const parsed = JSON.parse(toJSON(replay));
  assert.equal(parsed.games[0].turns[1].events[0].card, undefined);
  assert.equal(parsed.games[0].turns[2].events.at(-1).card.name, 'Counterspell');
  const md = toMarkdown(replay);
  assert.equal(md.indexOf('Counterspell') > md.indexOf('Arena Turn 3'), true);
});

test('unknown metadata is honest and all major semantic event types render', () => {
  const types = ['entered_battlefield', 'activated_ability', 'triggered_ability', 'attack', 'block', 'damage', 'dies', 'destroy', 'exile', 'sacrifice', 'discard', 'mill', 'bounce', 'zone_change', 'token_created', 'counter_changed', 'resolved', 'countered', 'mulligan', 'game_end'];
  const replay = fixture();
  replay.match.on_play = null;
  replay.games[0].on_play = null;
  replay.games[0].starting_hand = [];
  replay.games[0].turns[0].events = types.map((type, sequence) => ({ sequence, type, actor: 'me', card: { name: 'Test Creature', arena_id: 5, instance_id: 42, visibility: 'public' }, targets: [{ player: 'opponent' }], from: 'battlefield', to: 'graveyard', amount: 2, details: 'Observed detail' }));
  const md = toMarkdown(replay);
  assert.match(md, /On the play: Unknown/);
  assert.match(md, /Not recorded/);
  assert.equal(md.split('\n').filter(line => line.startsWith('- ')).length, types.length + 5);
});

test('adapter action names render semantic descriptions instead of internal ability enums', () => {
  const replay = fixture();
  replay.games[0].turns[0].events = ['enters', 'activate', 'trigger', 'ability', 'target', 'return'].map((type, sequence) => ({ sequence, type, actor: 'me', card: { name: 'Test Creature', arena_id: 5, instance_id: 42, visibility: 'public' }, targets: [{ player: 'opponent' }], to: 'hand', details: 'GameObjectType_Ability' }));
  const md = toMarkdown(replay);
  assert.match(md, /Test Creature #42 entered the battlefield \(Me\)/);
  assert.match(md, /Me activated Test Creature #42 → Opponent/);
  assert.match(md, /Test Creature #42 triggered → Opponent/);
  assert.match(md, /Ability created from Test Creature #42 \(trigger\/activation unspecified\)/);
  assert.match(md, /Me chose targets for Test Creature #42: Opponent/);
  assert.match(md, /Test Creature #42 returned to hand/);
  assert.doesNotMatch(md, /GameObjectType/);
});

test('game mulligan candidate preserves offered-before-kept chronology and filters hidden initial cards', () => {
  const replay = fixture();
  replay.games[0].decision_points = [{ type: 'mulligan', candidate_only: true, initial_hand: [
    { name: 'Island', arena_id: 8 },
    { name: 'Secret Initial Card', arena_id: 66666, visibility: 'hidden' },
  ] }];
  const md = toMarkdown(replay);
  assert.match(md, /\[Decision Point candidate\] Mulligan — candidate only; no legality inferred/);
  assert.match(md, /First offered hand: Island/);
  assert.match(md, /Kept hand: Mountain; Lightning Bolt/);
  assert.equal(md.indexOf('First offered hand') < md.indexOf('Kept hand'), true);
  assert.doesNotMatch(md, /Secret Initial Card/);
  assert.doesNotMatch(toJSON(replay), /Secret Initial Card|66666/);
  assert.equal(replay.games[0].decision_points[0].initial_hand.length, 2);
});
