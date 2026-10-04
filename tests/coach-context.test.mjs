import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoachContext } from '../src/coach-context.mjs';

function replay() {
  const ownCard = { name: 'Synthetic Flash Creature', arena_id: 100, instance_id: 200, visibility: 'player_known' };
  const future = { name: 'Synthetic Future Spell', arena_id: 998, instance_id: 300, visibility: 'public' };
  const player = hand => ({ life: 9, hand, handSize: hand.length, battlefield: [], graveyard: [], exile: [] });
  const before = { turn: 12, players: { me: player([ownCard]), opponent: { ...player([]), handSize: 2 } }, stack: [], warnings: ['Observed priority only'] };
  const after = structuredClone(before);
  after.players.me.hand = []; after.players.me.handSize = 0;
  after.players.me.battlefield = [{ ...ownCard, visibility: 'public' }];
  after.stack = [future];
  return { match: { id: 'synthetic-context' }, warnings: ['Canonical source'], games: [{ game_number: 1,
    states: { S0: before, S1: after }, steps: [
      { anchor: 'T12-A1', state_id: 'S1', before_state_id: 'S0', event: { type: 'cast', actor: 'opponent', card: future,
        targets: [future], amount: 8, details: 'Synthetic Future Spell deals 8 damage', life: { me: 1 } } },
      { anchor: 'T12-A2', state_id: 'S1', before_state_id: 'S0', event: { type: 'state', actor: 'me' } },
    ],
  }] };
}

test('selected canonical context preserves exact own hand and omits every newly public effect before the frame', () => {
  const input = replay(), untouched = structuredClone(input);
  const before = createCoachContext(input, { anchor: 'T12-A1', boundary: 'before' });
  assert.equal(before.schema_version, 'coach-context/1.0');
  assert.equal(before.state_boundary, 'before_gre_message');
  assert.equal(before.grouped_frame, true);
  assert.deepEqual(before.state.players.me.hand, input.games[0].states.S0.players.me.hand);
  assert.deepEqual(before.event, { type: 'cast', actor: 'opponent' });
  assert.doesNotMatch(JSON.stringify(before), /Synthetic Future Spell|998|300|deals 8 damage/);
  const after = createCoachContext(input, { anchor: 'T12-A1' });
  assert.equal(after.state_boundary, 'after_gre_message');
  assert.deepEqual(after.state.players.me.hand, []);
  assert.equal(after.event.card.name, 'Synthetic Future Spell');
  assert.deepEqual(input, untouched);
});

test('context defensively hides explicit private identities and keeps opponent hand count-only', () => {
  const input = replay();
  input.games[0].states.S0.players.opponent.hand = [{ name: 'Synthetic Hidden Hand', arena_id: 777, visibility: 'hidden' }];
  input.games[0].states.S0.players.opponent.exile = [{ name: 'Synthetic Face Down', arena_id: 776, visibility: 'hidden' }];
  const context = createCoachContext(input, { anchor: 'T12-A1', boundary: 'before' });
  assert.deepEqual(context.state.players.opponent.hand, []);
  assert.equal(context.state.players.opponent.handSize, 2);
  assert.deepEqual(context.state.players.opponent.exile, [{ hidden: true }]);
  assert.doesNotMatch(JSON.stringify(context), /Synthetic Hidden Hand|Synthetic Face Down|777|776/);
});

test('missing before frame falls back honestly to after; absent games and anchors remain absent', () => {
  const input = replay(); delete input.games[0].steps[0].before_state_id;
  const context = createCoachContext(input, { anchor: 'T12-A1', boundary: 'before' });
  assert.equal(context.state_boundary, 'after_gre_message');
  assert.equal(context.event.card.name, 'Synthetic Future Spell');
  assert.equal(createCoachContext(input, { anchor: 'T99-A99' }), null);
  assert.equal(createCoachContext(input, { gameNumber: 2, anchor: 'T12-A1' }), null);
  assert.equal(createCoachContext(null, { anchor: 'T12-A1' }), null);
});
