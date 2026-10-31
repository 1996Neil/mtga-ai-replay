import { performance } from 'node:perf_hooks';

const list = value => Array.isArray(value) ? value : [];
const hidden = value => value?.hidden === true || value?.is_face_down === true ||
  /hidden|post.?game|face.?down/i.test(String(value?.visibility ?? ''));
const copy = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value ?? {}, key))
  .map(key => [key, structuredClone(value[key])]));
const CARD_FIELDS = ['name', 'display_name_zh', 'arena_id', 'instance_id', 'logical_id', 'visibility',
  'owner', 'controller', 'card_types', 'is_tapped', 'is_token', 'is_ability', 'power', 'toughness',
  'damage', 'damage_marked', 'has_summoning_sickness', 'is_copy', 'colors', 'is_attacking',
  'attacking_target_id', 'is_blocking', 'blocked_attacker_ids', 'is_blocked', 'attack_state', 'block_state', 'attached_to', 'attachments',
  'type_line', 'mana_cost', 'keywords'];
const RULE_FIELDS = ['arena_id', 'name', 'display_name_zh', 'mana_cost', 'type_line', 'oracle_text',
  'keywords', 'power', 'toughness', 'source', 'certainty', 'missing_fields', 'metadata_complete',
  'quality_warnings', 'colors', 'color_identity', 'layout', 'card_faces'];

function safeCard(value, zone) {
  if (!value || hidden(value)) return { hidden: true, zone };
  const card = { ...copy(value, CARD_FIELDS), zone };
  card.counters = Array.isArray(value.counters) ? value.counters.map(c => copy(c, ['type', 'name', 'count']))
    : Object.fromEntries(Object.entries(value.counters ?? {}).filter(([, n]) => Number.isFinite(n)));
  card.targets = list(value.targets).map(target => target?.player ? copy(target, ['player']) : safeCard(target, 'target'));
  if (value.ability_source) card.ability_source = safeCard(value.ability_source, 'ability_source');
  return card;
}

/** One projection for both sources; never receives later replay actions/results. */
export function snapshotToLiveState(snapshot, { sessionId, matchId, gameId = '1', seq, stateId,
  rules = [], sourceMode = 'replay', previous = null, observedAtMonotonic = performance.now(),
  stateComplete = true, priorityObservation = null, offeredActions = null, terminal = false,
  ownKnowledgeIds = [] } = {}) {
  const board = { ...copy(snapshot, ['turn', 'phase', 'step', 'activePlayer', 'priorityPlayer', 'gameStateId']), players: {}, stack: [] };
  const missing = [];
  if (!snapshot?.players?.me || !snapshot?.players?.opponent) missing.push('players');
  for (const side of ['me', 'opponent']) {
    const player = snapshot?.players?.[side] ?? {};
    board.players[side] = { ...copy(player, ['life', 'handSize', 'librarySize', 'mana_pool', 'mana_pool_source']),
      name: side === 'me' ? 'Me' : 'Opponent', hand: side === 'me' ? list(player.hand).filter(c => !hidden(c)).map(c => safeCard(c, 'hand')) : [] };
    for (const zone of ['battlefield', 'graveyard', 'exile']) {
      if (!Array.isArray(player[zone])) missing.push(`${side}.${zone}`);
      board.players[side][zone] = list(player[zone]).map(c => safeCard(c, zone));
    }
  }
  board.stack = list(snapshot?.stack).map(c => safeCard(c, 'stack'));
  if (!Array.isArray(snapshot?.stack)) missing.push('stack');
  if (!Number.isInteger(board.turn)) missing.push('turn');
  if (!board.phase && board.turn > 0) missing.push('phase');
  const visible = new Set(ownKnowledgeIds);
  for (const player of Object.values(board.players)) for (const zone of ['hand', 'battlefield', 'graveyard', 'exile'])
    for (const card of player[zone]) if (!card.hidden && Number.isInteger(card.arena_id)) visible.add(card.arena_id);
  for (const card of board.stack) {
    if (!card.hidden && Number.isInteger(card.arena_id)) visible.add(card.arena_id);
    if (!card.ability_source?.hidden && Number.isInteger(card.ability_source?.arena_id)) visible.add(card.ability_source.arena_id);
  }
  const allRules = rules instanceof Map ? [...rules.values()] : list(rules);
  const filteredRules = allRules.filter(rule => !hidden(rule) && visible.has(Number(rule.arena_id))).map(rule => copy(rule, RULE_FIELDS));
  const ruleIds = new Set(filteredRules.filter(rule => typeof rule.oracle_text === 'string' || list(rule.card_faces).some(f => typeof f.oracle_text === 'string')).map(r => Number(r.arena_id)));
  for (const id of visible) if (!ruleIds.has(id)) missing.push(`rules:${id}`);
  if (!stateComplete) missing.push('full_state_not_observed');
  const sameGame = previous?.session_id === sessionId && previous?.match_id === matchId && String(previous?.game_id) === String(gameId);
  const sameTurn = sameGame && previous.turn === board.turn;
  const lifeLost = {};
  for (const side of ['me', 'opponent']) {
    const oldLife = previous?.board?.players?.[side]?.life, life = board.players[side].life;
    const decreased = sameGame && Number.isFinite(oldLife) && Number.isFinite(life) && life < oldLife;
    // A decrease proves loss. First/mid-turn snapshots cannot prove no loss.
    lifeLost[side] = decreased ? true : sameTurn ? previous.life_lost_this_turn?.[side] ?? null : null;
  }
  const battlefield = [...board.players.me.battlefield, ...board.players.opponent.battlefield].filter(c => !c.hidden);
  const knownPriority = ['me', 'opponent'].includes(priorityObservation?.player) ? priorityObservation.player :
    ['me', 'opponent'].includes(board.priorityPlayer) ? board.priorityPlayer : null;
  const priority = { player: knownPriority, source: knownPriority ? priorityObservation?.source ?? 'last_observed' : 'unknown',
    observed_seq: knownPriority ? priorityObservation?.observed_seq ?? (sameGame ? previous?.priority?.observed_seq : null) ?? null : null,
    fresh: Boolean(knownPriority && priorityObservation?.fresh && priorityObservation.observed_seq === seq) };
  return { schema: 'MTGA_LIVE_STATE_V1', session_id: sessionId, match_id: matchId, game_id: String(gameId), seq,
    state_id: stateId, observed_at_monotonic: observedAtMonotonic, source_event_time: null, source_mode: sourceMode,
    turn: board.turn ?? null, phase: board.phase ?? null, step: board.step ?? null,
    active_player: board.activePlayer ?? null, priority, board, rules: filteredRules,
    coverage: { dynamic_abilities: 'unknown', state_complete: stateComplete && !missing.some(item => !item.startsWith('rules:')), missing: [...new Set(missing)] },
    committed_combat: { attackers: battlefield.filter(c => c.is_attacking && c.attack_state !== 'AttackState_Declared').map(c => c.instance_id),
      blockers: battlefield.filter(c => c.block_state !== 'BlockState_Declared' && list(c.blocked_attacker_ids).length).map(c => ({ instance_id: c.instance_id, attacker_ids: [...c.blocked_attacker_ids] })),
      source: 'current_observed_snapshot' },
    tentative: { known: battlefield.some(c => c.attack_state === 'AttackState_Declared' || c.block_state === 'BlockState_Declared'),
      attackers: battlefield.filter(c => c.attack_state === 'AttackState_Declared').map(c => c.instance_id),
      blockers: battlefield.filter(c => c.block_state === 'BlockState_Declared').map(c => ({ instance_id: c.instance_id, attacker_ids: [...list(c.blocked_attacker_ids)] })),
      targets: null, source: 'current_observed_snapshot' },
    offered_actions: offeredActions ? structuredClone(offeredActions) : null,
    terminal: Boolean(terminal), life_lost_this_turn: lifeLost };
}
