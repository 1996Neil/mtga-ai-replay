import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const decisionNoteHash = note => hash(note);
const list = value => Array.isArray(value) ? value : [];
const hidden = card => !card || card.hidden || card.is_face_down || card.face_down
  || /hidden|private|post.?game|face.?down/i.test(card.visibility ?? '');
const cardRef = card => hidden(card) ? null : Object.fromEntries(
  ['arena_id', 'instance_id', 'logical_id', 'name'].filter(key => card[key] != null).map(key => [key, card[key]]));
const fail = reason => { throw new Error(`Decision audit: ${reason}`); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const keyOf = step => step.event?.card?.logical_id ?? step.event?.card?.instance_id ?? step.event?.card?.arena_id;
const stateAt = (game, step, boundary) => boundary === 'before'
  ? step.state_before ?? game.states?.[step.before_state_id]
  : step.state ?? game.states?.[step.after_state_id ?? step.state_id];

/**
 * Explicit offline authoring aid, not an evaluation of legal moves or strategic
 * quality. Read one supplied game; never fetch, mutate a replay or run on reads.
 * Each item is an obligation to inspect, not a quota for displayed comments.
 */
export function buildDecisionAudit({ replay, cards = [], source_content_hash, game_number = 1 }) {
  if (!/^[a-f0-9]{64}$/.test(source_content_hash ?? '')) fail('source hash required');
  const game = list(replay?.games).find(game => game.game_number === game_number);
  const match = replay?.match?.id ?? replay?.match?.match_id;
  if (!match || !game || !list(game.steps).length) fail('one observed game required');
  const steps = game.steps, rules = new Map(cards.map(card => [card.arena_id, card]));
  const position = new Map();
  for (const [index, step] of steps.entries()) {
    if (!/^T\d+-A\d+$/.test(step.anchor ?? '') || position.has(step.anchor)) fail('unique observed anchors required');
    position.set(step.anchor, index);
  }
  const items = [], turns = new Map();
  const add = (kind, step, boundary, events, extra = {}) => {
    const state = stateAt(game, step, boundary);
    const item = { id: `${kind}:${step.anchor}`, kind, anchor: step.anchor, boundary,
      state_id: boundary === 'before' ? step.before_state_id ?? null : step.after_state_id ?? step.state_id ?? null,
      state_available: Boolean(state), turn: step.turn ?? state?.turn,
      grouped_frame: Boolean(step.grouped_frame), state_boundary: step.state_boundary ?? null,
      intra_frame_order: step.certainty?.intra_frame_order ?? 'unknown',
      evidence: events.map(eventStep => eventStep.anchor), ...extra };
    items.push(item); return item;
  };
  const ownActions = new Set(['cast', 'activate', 'ability', 'target', 'attack', 'block', 'discard', 'land', 'land_played']);
  for (const step of steps) {
    const turn = step.turn ?? stateAt(game, step, 'after')?.turn;
    if (!Number.isInteger(turn)) fail('observed turn required');
    const row = turns.get(turn) ?? []; row.push(step); turns.set(turn, row);
  }
  const opening = steps.find(step => (step.turn ?? stateAt(game, step, 'after')?.turn) === 0);
  if (opening) add('opening', opening, 'after', [opening]);
  for (const [turn, rows] of turns) {
    if (turn === 0) continue;
    const active = rows.map(step => stateAt(game, step, 'after')?.activePlayer).find(Boolean);
    const actions = rows.filter(step => step.event?.actor === 'me' && ownActions.has(step.event.type));
    // Include own quiet turns, including a missed land or attack. Opponent
    // turns get a response window even if the player chose to pass throughout.
    const start = rows.find(step => /main/i.test(stateAt(game, step, 'after')?.phase ?? '')) ?? rows[0];
    add(active === 'me' ? 'turn-plan' : 'response-plan', start, 'before', rows, {
      active_player: active ?? null, actual_actions: actions.map(step => ({
        anchor: step.anchor, type: step.event.type, card: cardRef(step.event.card),
        targets: list(step.event.targets).map(target => target.player ? { player: target.player } : cardRef(target)),
      })),
    });
    if (active === 'me') {
      const landWindow = rows.find(step => /main/i.test(stateAt(game, step, 'after')?.phase ?? '')
        && list(stateAt(game, step, 'before')?.players?.me?.hand).some(card => !hidden(card) && list(card.card_types).includes('Land')));
      if (landWindow) add('land-window', landWindow, 'before', rows.filter(step => step.event?.actor === 'me'
        && ['land', 'land_played', 'draw'].includes(step.event.type)), {
        actual_land_plays: rows.filter(step => step.event?.actor === 'me' && ['land', 'land_played'].includes(step.event.type)).map(step => step.anchor),
      });
    }
    const combat = rows.filter(step => ['attack', 'block'].includes(step.event?.type));
    const combatPhase = rows.find(step => /combat/i.test(stateAt(game, step, 'after')?.phase ?? ''));
    const combatState = combatPhase && stateAt(game, combatPhase, 'before');
    const ready = list(combatState?.players?.me?.battlefield).some(card => !hidden(card)
      && list(card.card_types).includes('Creature') && !card.is_tapped && !card.has_summoning_sickness);
    if (combat.length || active === 'me' && ready && combatPhase) {
      const first = combatPhase ?? combat[0];
      add('combat-plan', first, 'before', combat.length ? combat : [first], {
        actual_actions: combat.map(step => ({ anchor: step.anchor, actor: step.event.actor, type: step.event.type,
          card: cardRef(step.event.card), targets: list(step.event.targets).map(cardRef) })),
      });
    }
    const seen = new Set();
    for (const step of actions) {
      if (!['cast', 'target', 'activate', 'ability', 'discard'].includes(step.event.type)) continue;
      const kind = step.event.type === 'target' ? 'target-choice' : step.event.type === 'cast' ? 'spell-choice'
        : ['activate', 'ability'].includes(step.event.type) ? 'ability-choice' : 'discard-choice';
      const key = `${kind}:${keyOf(step)}:${step.state_id}`;
      if (seen.has(key)) continue; seen.add(key);
      const group = actions.filter(other => other.event.type === step.event.type
        && keyOf(other) === keyOf(step) && other.state_id === step.state_id);
      add(kind, step, 'before', group, { actual_card: cardRef(step.event.card),
        targets: group.flatMap(other => list(other.event.targets)).map(target => target.player ? { player: target.player } : cardRef(target)) });
    }
    const draws = rows.filter(step => step.event?.actor === 'me' && step.event.type === 'draw'
      && /main/i.test(stateAt(game, step, 'after')?.phase ?? ''));
    for (const step of draws) if (draws.filter(other => other.state_id === step.state_id).at(-1) === step)
      add('draw-window', step, 'after', draws.filter(other => other.state_id === step.state_id));
  }
  // Hand reveals can be present only in public events, while opponent.hand is
  // intentionally empty. Recover just this choice's candidates from earlier
  // reveal events; never fill a hidden hand from the final card dictionary.
  const consumedReaders = new Set();
  for (const [index, step] of steps.entries()) {
    if (!['exile', 'discard'].includes(step.event?.type) || step.event.actor !== 'opponent'
      || !/^hand$/i.test(step.event.from ?? '')) continue;
    let origin = -1;
    for (let before = index - 1; before >= 0; before--) {
      if (steps[before].turn !== step.turn) break;
      const event = steps[before].event;
      if (event?.actor === 'me' && event.type === 'cast') {
        const oracle = rules.get(event.card?.arena_id)?.oracle_text ?? '';
        const result = /exile that card/i.test(oracle) ? 'exile'
          : /discards? (?:that|the chosen) card/i.test(oracle) ? 'discard' : null;
        if (!consumedReaders.has(before) && result === step.event.type
          && /opponent reveals (?:their|his or her) hand/i.test(oracle) && /choose/i.test(oracle)) { origin = before; break; }
      }
    }
    const reveals = origin < 0 ? [] : steps.slice(origin + 1, index).filter(other => other.turn === step.turn
      && other.state_id === step.before_state_id && other.event?.actor === 'opponent'
      && other.event.type === 'reveal' && !hidden(other.event.card));
    if (origin < 0 && !reveals.length) continue;
    const candidates = [...new Map(reveals.map(other => [other.event.card.arena_id + ':' + other.event.card.instance_id,
      { ...cardRef(other.event.card), revealed_at: other.anchor }])).values()];
    const handSize = stateAt(game, step, 'before')?.players?.opponent?.handSize;
    const complete = Number.isInteger(handSize) && candidates.length === handSize
      && candidates.some(card => card.arena_id === step.event.card?.arena_id);
    add('hand-choice', step, 'before', reveals, { origin_anchor: origin >= 0 ? steps[origin].anchor : null,
      candidates, chosen: cardRef(step.event.card), candidates_from: 'chronological_reveal_events',
      observed_hand_size: handSize ?? null,
      candidates_complete: complete });
    if (complete) consumedReaders.add(origin);
    add('conversion-window', step, 'after', [step], { chosen: cardRef(step.event.card) });
  }
  items.sort((a, b) => position.get(a.anchor) - position.get(b.anchor) || a.kind.localeCompare(b.kind));
  const evidence = { match_id: match, game_number, source_content_hash,
    // Bind to exact supplied rules and states, not merely a claimed hash.
    input_hash: hash({ game, cards }), items };
  return { schema: 'MTGA_DECISION_AUDIT_PLAN_V1', ...evidence, plan_hash: hash(evidence) };
}

/**
 * Reject missing decisions before editorial selection. This verifies coverage,
 * chronological evidence and report linkage; an independent strategic review
 * still checks whether the authored comparisons actually make sense.
 */
export function validateDecisionAudit(plan, ledger, report) {
  if (plan?.schema !== 'MTGA_DECISION_AUDIT_PLAN_V1') fail('bad plan');
  const { schema, plan_hash, ...evidence } = plan;
  if (hash(evidence) !== plan_hash) fail('plan changed');
  if (ledger?.schema !== 'MTGA_DECISION_AUDIT_LEDGER_V1' || ledger.plan_hash !== plan_hash
    || ledger.match_id !== plan.match_id || ledger.game_number !== plan.game_number) fail('stale ledger');
  const expected = new Map(plan.items.map(item => [item.id, item])), covered = new Set(), notes = new Set();
  for (const row of list(ledger.analyses)) {
    if (!list(row.covers).length || !['retain', 'change', 'unresolved'].includes(row.verdict)) fail('analysis decision required');
    for (const field of ['facts', 'actual', 'preference', 'reason', 'opportunity_cost', 'opponent_response', 'next_window'])
      if (!text(row[field])) fail(`comparison missing ${field}`);
    if (!list(row.alternatives).length || row.alternatives.some(line => !text(line))) fail('executable alternative required');
    const ids = row.covers.map(id => { const item = expected.get(id); if (!item || covered.has(id)) fail('unknown or duplicate decision');
      covered.add(id); return item; });
    if (new Set(ids.map(item => item.turn)).size !== 1) fail('each turn needs its own comparison');
    if (!row.checks || Object.keys(row.checks).length !== ids.length) fail('each decision needs its own check');
    for (const item of ids) {
      const check = row.checks[item.id], possible = new Set([item.anchor, ...item.evidence]);
      if (!text(check?.comparison) || !list(check?.evidence).length
        || check.evidence.some(anchor => !possible.has(anchor))) fail('each decision needs chronological evidence and comparison');
    }
    // A revealed-hand choice always has its own comparison, so it cannot be
    // swallowed by a generic "this turn rebuilt the board" paragraph.
    if (ids.some(item => item.kind === 'hand-choice') && ids.length !== 1) fail('hand choice needs its own comparison');
    if (ids.some(item => !item.state_available) && row.verdict !== 'unresolved') fail('unobserved state must stay unresolved');
    if (ids.some(item => item.kind === 'hand-choice' && !item.candidates_complete) && row.verdict !== 'unresolved')
      fail('incomplete reveal must stay unresolved');
    for (const item of ids.filter(item => item.kind === 'hand-choice' && item.candidates_complete)) {
      const choices = new Map(list(row.hand_options).map(option => [`${option.arena_id}:${option.instance_id}`, option]));
      if (choices.size !== item.candidates.length || choices.size !== row.hand_options.length) fail('compare every revealed candidate');
      for (const card of item.candidates) {
        const option = choices.get(`${card.arena_id}:${card.instance_id}`);
        if (!option || !text(option.opponent_use) || !text(option.own_use) || !text(option.cost_and_timing))
          fail('hand candidate needs both players and payment timing');
      }
    }
    const possible = new Set(ids.flatMap(item => [item.anchor, ...item.evidence]));
    if (!list(row.evidence).length || row.evidence.some(anchor => !possible.has(anchor))) fail('evidence outside decision window');
    if (row.verdict === 'unresolved' && !text(row.missing_evidence)) fail('unresolved evidence required');
    if (row.display) {
      if (row.verdict === 'unresolved') fail('unresolved comparison cannot certify a displayed note');
      const { anchor, boundary } = row.display;
      if (!ids.some(item => item.anchor === anchor && item.boundary === boundary)) fail('display outside inspected boundaries');
      const key = `${anchor}/${boundary}`;
      if (notes.has(key)) fail('duplicate display');
      notes.add(key);
    }
  }
  const missing = [...expected.keys()].filter(key => !covered.has(key));
  if (missing.length) fail(`unreviewed decisions: ${missing.join(', ')}`);
  if (report) {
    if (report.match_id !== plan.match_id || report.game_number !== plan.game_number
      || report.source_content_hash !== plan.source_content_hash) fail('report source mismatch');
    const displayed = new Set(list(report.notes).map(note => `${note.anchor}/${note.boundary}`));
    if (displayed.size !== report.notes.length || displayed.size !== notes.size || [...displayed].some(key => !notes.has(key)))
      fail('report notes differ from inspected selections');
    for (const row of ledger.analyses.filter(row => row.display)) {
      const note = report.notes.find(note => note.anchor === row.display.anchor && note.boundary === row.display.boundary);
      if (row.display.note_hash !== decisionNoteHash(note)) fail('displayed note content changed after inspection');
    }
  }
  return { status: 'covered', decisions: covered.size, analyses: ledger.analyses.length, displayed: notes.size,
    unresolved: ledger.analyses.filter(row => row.verdict === 'unresolved').length, plan_hash };
}
