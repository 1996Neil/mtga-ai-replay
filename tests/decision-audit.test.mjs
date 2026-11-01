import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionAudit, validateDecisionAudit, decisionNoteHash } from '../src/review/decision-audit.mjs';

const card = (arena_id, name) => ({ arena_id, name, instance_id: arena_id, visibility: 'public' });
function input() {
  const own = card(1, 'Hand Reader'), a = card(2, 'Uncastable Giant'), b = card(3, 'Immediate Answer');
  const state = activePlayer => ({ turn: 3, phase: 'Phase_Main1', activePlayer,
    players: { me: { hand: [], battlefield: [] }, opponent: { hand: [], handSize: 2, battlefield: [] } } });
  const steps = [
    { anchor: 'T3-A1', turn: 3, before_state_id: 'S1', state_id: 'S2', event: { actor: 'me', type: 'cast', card: own } },
    { anchor: 'T3-A2', turn: 3, before_state_id: 'S2', state_id: 'S3', event: { actor: 'opponent', type: 'reveal', card: a } },
    { anchor: 'T3-A3', turn: 3, before_state_id: 'S2', state_id: 'S3', event: { actor: 'opponent', type: 'reveal', card: b } },
    { anchor: 'T3-A4', turn: 3, before_state_id: 'S3', state_id: 'S4', event: { actor: 'opponent', type: 'exile', from: 'Hand', to: 'Exile', card: a } },
    { anchor: 'T4-A1', turn: 4, before_state_id: 'S4', state_id: 'S5', event: { actor: 'opponent', type: 'cast', card: b } },
    { anchor: 'T4-A2', turn: 4, before_state_id: 'S5', state_id: 'S6', event: { actor: 'opponent', type: 'reveal', card: card(99, 'Future Card') } },
  ];
  return { source_content_hash: 'a'.repeat(64),
    replay: { match: { id: 'fixture-match' }, games: [{ game_number: 1, steps,
      states: Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => [`S${n}`, state(n >= 5 ? 'opponent' : 'me')])) }] },
    cards: [{ arena_id: 1, oracle_text: 'Target opponent reveals their hand. You choose a nonland card from it. Exile that card.' },
      { arena_id: 99, name: 'Never Known Yet', oracle_text: 'Future rules' }] };
}
const authored = plan => ({ schema: 'MTGA_DECISION_AUDIT_LEDGER_V1', match_id: plan.match_id,
  game_number: plan.game_number, plan_hash: plan.plan_hash, analyses: plan.items.map(item => ({
    covers: [item.id], verdict: 'retain', evidence: [item.anchor], facts: 'Observed resources',
    actual: 'Actual move', alternatives: ['Pay the recorded cost for another plan'], preference: 'Actual',
    reason: 'A specific exchange', opportunity_cost: 'Forgo a body', opponent_response: 'Trade or pass',
    next_window: 'Reassess at the next attack',
    checks: { [item.id]: { comparison: 'This actual action versus the specified alternative', evidence: [item.anchor] } },
    ...(item.kind === 'hand-choice' ? { hand_options: item.candidates.map(card => ({ arena_id: card.arena_id,
      instance_id: card.instance_id, opponent_use: 'Their available sources', own_use: 'My available sources',
      cost_and_timing: 'Cost and the first observed window' })) } : {}),
  })) });

test('reveal choices are recovered despite an empty opponent hand, without future/dictionary identities', () => {
  const plan = buildDecisionAudit(input()), choice = plan.items.find(item => item.kind === 'hand-choice');
  assert.equal(choice.anchor, 'T3-A4'); assert.equal(choice.boundary, 'before');
  assert.deepEqual(choice.candidates.map(card => card.name), ['Uncastable Giant', 'Immediate Answer']);
  assert.deepEqual(choice.candidates.map(card => card.revealed_at), ['T3-A2', 'T3-A3']);
  assert.equal(choice.chosen.name, 'Uncastable Giant');
  assert.ok(!JSON.stringify(choice).includes('Future'));
});

test('a missing hand-choice and a missing quiet response turn reject before display selection', () => {
  const plan = buildDecisionAudit(input());
  for (const kind of ['hand-choice', 'response-plan']) {
    const ledger = authored(plan); ledger.analyses = ledger.analyses.filter(row => !row.covers[0].startsWith(kind + ':'));
    assert.throws(() => validateDecisionAudit(plan, ledger), /unreviewed decisions/);
  }
});

test('hand choices cannot be hidden in a generic turn comparison', () => {
  const plan = buildDecisionAudit(input()), ledger = authored(plan);
  const index = ledger.analyses.findIndex(row => row.covers[0].startsWith('hand-choice'));
  Object.assign(ledger.analyses[0].checks, ledger.analyses[index].checks);
  ledger.analyses[0].covers.push(ledger.analyses[index].covers[0]); ledger.analyses.splice(index, 1);
  assert.throws(() => validateDecisionAudit(plan, ledger), /hand choice needs its own comparison/);
});

test('a single generic paragraph cannot certify multiple turns or omit per-decision comparisons', () => {
  const plan = buildDecisionAudit(input()), ledger = authored(plan);
  const last = ledger.analyses.pop();
  ledger.analyses[0].covers.push(...last.covers); Object.assign(ledger.analyses[0].checks, last.checks);
  assert.throws(() => validateDecisionAudit(plan, ledger), /each turn/);
  const missing = authored(plan); delete missing.analyses[0].checks;
  assert.throws(() => validateDecisionAudit(plan, missing), /each decision/);
});

test('an intervening response does not mix an older reveal into the current choice', () => {
  const value = input(), game = value.replay.games[0];
  game.steps.splice(1, 0, { anchor: 'T3-A0', turn: 3, before_state_id: 'S1', state_id: 'S1',
    event: { actor: 'opponent', type: 'reveal', card: card(88, 'Unrelated Reveal') } });
  game.steps.splice(4, 0, { anchor: 'T3-A5', turn: 3, before_state_id: 'S3', state_id: 'S3',
    event: { actor: 'me', type: 'cast', card: card(44, 'Response Spell') } });
  const choice = buildDecisionAudit(value).items.find(item => item.kind === 'hand-choice');
  assert.equal(choice.origin_anchor, 'T3-A1');
  assert.deepEqual(choice.candidates.map(card => card.name), ['Uncastable Giant', 'Immediate Answer']);
});

test('opponent paying a discard cost before a hand reveal does not consume an exile reader', () => {
  const value = input(), steps = value.replay.games[0].steps;
  steps.splice(1, 0, { anchor: 'T3-A6', turn: 3, before_state_id: 'S2', state_id: 'S2',
    event: { actor: 'opponent', type: 'discard', from: 'Hand', to: 'Graveyard', card: card(55, 'Book Cost') } });
  const choices = buildDecisionAudit(value).items.filter(item => item.kind === 'hand-choice');
  assert.deepEqual(choices.map(item => item.anchor), ['T3-A4']);
  assert.equal(choices[0].candidates_complete, true);
});

test('both players and payment timing must be compared for every revealed card', () => {
  const plan = buildDecisionAudit(input()), ledger = authored(plan);
  const choice = ledger.analyses.find(row => row.hand_options);
  delete choice.hand_options[0].cost_and_timing;
  assert.throws(() => validateDecisionAudit(plan, ledger), /payment timing/);
});

test('source states or rule changes invalidate previous authored work even under the same claimed hash', () => {
  const original = input(), plan = buildDecisionAudit(original), ledger = authored(plan);
  for (const change of [copy => { copy.replay.games[0].states.S3.players.me.life = 1; },
    copy => { copy.cards[0].oracle_text += ' Updated cost.'; }, copy => { copy.source_content_hash = 'b'.repeat(64); }]) {
    const copy = structuredClone(original); change(copy);
    assert.throws(() => validateDecisionAudit(buildDecisionAudit(copy), ledger), /stale ledger/);
  }
});

test('future evidence, incomplete comparisons and duplicate decisions fail', () => {
  const plan = buildDecisionAudit(input());
  for (const change of [ledger => { ledger.analyses.find(row => row.covers[0].startsWith('hand-choice')).evidence = ['T4-A2']; },
    ledger => { ledger.analyses[0].opportunity_cost = ''; },
    ledger => { ledger.analyses.push(ledger.analyses[0]); }]) {
    const ledger = authored(plan); change(ledger);
    assert.throws(() => validateDecisionAudit(plan, ledger));
  }
});

test('report selection must match inspected notes; full inspection can still display none', () => {
  const plan = buildDecisionAudit(input()), ledger = authored(plan);
  const report = { match_id: plan.match_id, game_number: 1, source_content_hash: plan.source_content_hash, notes: [] };
  assert.equal(validateDecisionAudit(plan, ledger, report).displayed, 0);
  report.notes.push({ anchor: 'T3-A4', boundary: 'before' });
  assert.throws(() => validateDecisionAudit(plan, ledger, report), /report notes differ/);
  ledger.analyses.find(row => row.covers[0].startsWith('hand-choice')).display = {
    anchor: 'T3-A4', boundary: 'before', note_hash: decisionNoteHash(report.notes[0]) };
  assert.equal(validateDecisionAudit(plan, ledger, report).displayed, 1);
  report.notes[0].suggestion = 'Different advice at the same anchor';
  assert.throws(() => validateDecisionAudit(plan, ledger, report), /content changed/);
  ledger.analyses.find(row => row.display).verdict = 'unresolved';
  assert.throws(() => validateDecisionAudit(plan, ledger, report), /unresolved/);
});

test('no candidate snapshot or only a partial revealed hand cannot be certified as inspected', () => {
  for (const prune of [steps => steps.filter(step => step.event.type !== 'reveal'),
    steps => steps.filter(step => step.anchor !== 'T3-A3')]) {
    const value = input(); value.replay.games[0].steps = prune(value.replay.games[0].steps);
    const plan = buildDecisionAudit(value), ledger = authored(plan);
    assert.throws(() => validateDecisionAudit(plan, ledger), /incomplete reveal/);
  }
});

test('a land held through a quiet main phase is still an inspection obligation', () => {
  const value = input();
  value.replay.games[0].states.S1.players.me.hand = [{ ...card(10, 'Island'), card_types: ['Land'] }];
  const plan = buildDecisionAudit(value);
  const land = plan.items.find(item => item.kind === 'land-window');
  assert.ok(land); assert.deepEqual(land.actual_land_plays, []);
  const ledger = authored(plan);
  ledger.analyses = ledger.analyses.filter(row => !row.covers.includes(land.id));
  assert.throws(() => validateDecisionAudit(plan, ledger), /unreviewed decisions/);
});

test('hidden reveals and unobserved states do not become certified decisions', () => {
  const value = input();
  value.replay.games[0].steps[2].event.card.visibility = 'post_game';
  delete value.replay.games[0].states.S3;
  const plan = buildDecisionAudit(value), ledger = authored(plan);
  assert.equal(plan.items.find(item => item.kind === 'hand-choice').candidates.length, 1);
  assert.throws(() => validateDecisionAudit(plan, ledger), /unobserved state/);
  for (const row of ledger.analyses) if (row.covers.some(id => !plan.items.find(item => item.id === id).state_available)) {
    row.verdict = 'unresolved'; row.missing_evidence = 'Missing pre-choice frame';
  }
  assert.equal(validateDecisionAudit(plan, ledger).unresolved, 1);
});
