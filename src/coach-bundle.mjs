import { createHash } from 'node:crypto';
import packageInfo from '../package.json' with { type: 'json' };
import { validateBundleFiles } from './sync-security.mjs';

const SHARED_FRAME_WARNING = 'Exact intermediate board state was not observed; actions can share a GRE frame.';
const PRIORITY_WARNING = 'Priority is the last observed GRE value; unrecorded priority windows are unknown.';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const list = value => Array.isArray(value) ? value : [];
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const unique = values => [...new Set(values)];
const hidden = value => Boolean(value?.hidden === true || value?.is_face_down === true || value?.face_down === true
  || /hidden|post.?game|private|face.?down/i.test(String(value?.visibility ?? '')));
const copyKeys = (value, keys) => Object.fromEntries(keys.filter(key => own(value, key)).map(key => [key, structuredClone(value[key])]));
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
export const serializeCoachJson = value => value?.schema === 'MTGA_COACH_PART_V1'
  ? ['{', '  "schema": "MTGA_COACH_PART_V1",', `  "kind": ${JSON.stringify(value.kind)},`, '  "records": {',
    ...Object.entries(value.records).map(([key, record], i, entries) => `    ${JSON.stringify(key)}: ${JSON.stringify(record)}${i < entries.length - 1 ? ',' : ''}`),
    '  }', '}', ''].join('\n')
  : JSON.stringify(value, null, 2) + '\n';

const MAX_MAIN_BYTES = 900 * 1024;
const REF_SCHEMA = 'MTGA_COACH_REFERENCE_V1';
const isReference = value => plain(value) && Object.keys(value).length === 1 && plain(value.$ref)
  && typeof value.$ref.file === 'string' && typeof value.$ref.key === 'string';

/** Resolves only supplied JSON objects; never reads a path, makes a request or guesses a board. */
export function resolveCoachBundle(coach, parts = new Map()) {
  const files = parts instanceof Map ? parts : new Map(Object.entries(parts));
  const active = new Set();
  const resolve = value => {
    if (isReference(value)) {
      const { file, key } = value.$ref, token = `${file}:${key}`;
      if (active.has(token)) throw new Error('Cyclic Coach part reference.');
      let part = files.get(file);
      if (typeof part === 'string') part = JSON.parse(part);
      if (part?.schema !== 'MTGA_COACH_PART_V1' || !own(part.records, key)) throw new Error('Missing Coach part reference.');
      active.add(token); const result = resolve(part.records[key]); active.delete(token); return result;
    }
    if (plain(value) && Array.isArray(value.$chunks) && ['array', 'object', 'string'].includes(value.type)) {
      const chunks = value.$chunks.map(resolve);
      return value.type === 'array' ? chunks.flat() : value.type === 'string' ? chunks.join('') : Object.assign({}, ...chunks);
    }
    return Array.isArray(value) ? value.map(resolve) : plain(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child)])) : value;
  };
  const input = { ...coach }; if (input.reference_encoding?.schema === REF_SCHEMA) delete input.reference_encoding;
  return resolve(input);
}

function semanticMultipart(expanded, historyKey, { partitionBytes = 700 * 1024, multipart = 'auto' } = {}) {
  if (!Number.isSafeInteger(partitionBytes) || partitionBytes < 1024) throw new Error('Coach partitionBytes must be an integer of at least 1024.');
  const parts = new Map(), ranges = new Map(); let current = null, currentPath = null, size = 0, serial = 0;
  const fresh = kind => {
    currentPath = `matches/${historyKey}/parts/part-${String(++serial).padStart(4, '0')}.json`;
    current = { schema: 'MTGA_COACH_PART_V1', kind, records: {} }; parts.set(currentPath, current);
    size = Buffer.byteLength(serializeCoachJson(current));
  };
  const store = (kind, key, value) => {
    const rowBytes = Buffer.byteLength(`    ${JSON.stringify(key)}: ${JSON.stringify(value)},\n`);
    // Extremely large containers are split structurally; ordinary boards remain one full JSON row.
    if (rowBytes + 128 > partitionBytes) {
      if (typeof value === 'string') {
        const chunks = []; const characters = Math.max(1, Math.floor((partitionBytes - 256) / 6));
        for (let i = 0; i < value.length; i += characters) chunks.push(store(kind, `${key}:text:${i}`, value.slice(i, i + characters)));
        return store(kind, key, { type: 'string', $chunks: chunks });
      }
      const array = Array.isArray(value), entries = array ? value.map((child, i) => [i, child]) : Object.entries(value);
      const chunks = []; let group = [], bytes = 128;
      const flush = () => { if (!group.length) return; const v = array ? group.map(([, child]) => child) : Object.fromEntries(group);
        chunks.push(store(kind, `${key}:chunk:${chunks.length + 1}`, v)); group = []; bytes = 128; };
      for (const [field, child] of entries) {
        let safeChild = child; const amount = Buffer.byteLength(JSON.stringify(child));
        if (amount + 256 > partitionBytes) safeChild = store(kind, `${key}:field:${field}`, child);
        const needed = Buffer.byteLength(JSON.stringify([field, safeChild]));
        if (bytes + needed > partitionBytes - 256) flush(); group.push([field, safeChild]); bytes += needed;
      }
      flush(); return store(kind, key, { type: array ? 'array' : 'object', $chunks: chunks });
    }
    if (!current || current.kind !== kind || size + rowBytes > partitionBytes) fresh(kind);
    const line = 5 + Object.keys(current.records).length;
    current.records[key] = value; size += rowBytes;
    const ref = { $ref: { file: currentPath, key } };
    ranges.set(`${currentPath}:${key}`, { file: currentPath, key, start_line: line, end_line: line });
    return ref;
  };
  const coach = structuredClone(expanded);
  if (multipart === false || (multipart !== true && Buffer.byteLength(serializeCoachJson(coach)) <= MAX_MAIN_BYTES)) return { coach, parts, ranges };
  for (const [index, game] of coach.games.entries()) game.states = Object.fromEntries(Object.entries(game.states).map(([id, state]) => [id, store('states', `G${index + 1}:${id}`, state)]));
  if (Buffer.byteLength(serializeCoachJson(coach)) > MAX_MAIN_BYTES) {
    for (const [index, game] of coach.games.entries()) game.turns = game.turns.map((turn, i) => store('turns', `G${index + 1}:turn:${i + 1}`, turn));
  }
  if (Buffer.byteLength(serializeCoachJson(coach)) > MAX_MAIN_BYTES) {
    for (const [index, game] of coach.games.entries()) game.steps = game.steps.map((step, i) => store('actions', `G${index + 1}:${step.anchor ?? i + 1}`, step));
  }
  // Arbitrarily long games can also move their reference indexes, with no gameplay pruning.
  if (Buffer.byteLength(serializeCoachJson(coach)) > MAX_MAIN_BYTES) {
    for (const [index, game] of coach.games.entries()) {
      for (const field of ['states', 'steps', 'turns', 'opening', 'decision_points']) game[field] = store('indexes', `G${index + 1}:${field}`, game[field]);
    }
  }
  coach.reference_encoding = { schema: REF_SCHEMA, base: 'repository_root',
    instructions: 'Replace {$ref:{file,key}} with parts[file].records[key]. Each ordinary state is one complete JSON row. Concatenate typed $chunks only for oversized containers.',
    parts: [...parts].map(([file, part]) => ({ file, kind: part.kind, record_count: Object.keys(part.records).length,
      first_record: Object.keys(part.records)[0], last_record: Object.keys(part.records).at(-1), node_line_start: 5, node_line_stride: 1 })) };
  for (const part of parts.values()) if (Buffer.byteLength(serializeCoachJson(part)) > partitionBytes) throw new Error('Coach part exceeded its declared file budget.');
  return { coach, parts, ranges };
}

const CARD_FIELDS = ['name', 'arena_id', 'instance_id', 'visibility', 'logical_id', 'card_types', 'is_tapped', 'is_token', 'is_ability',
  'power', 'toughness', 'is_attacking', 'attacking_target_id', 'is_blocking', 'blocked_attacker_ids', 'attached_to', 'attachments',
  'target_ids', 'owner', 'controller', 'damage', 'damage_marked', 'mana_cost', 'type_line', 'keywords', 'known', 'face_down',
  'transformed', 'transform_state', 'loyalty', 'defense', 'colors', 'quantity', 'count', 'is_face_down',
  'ability_kind', 'known_effect', 'effect', 'stack_order', 'ordering', 'object_type', 'has_summoning_sickness', 'is_copy'];
const EVENT_FIELDS = ['sequence', 'type', 'actor', 'from', 'to', 'amount', 'details', 'phase', 'step', 'state_id', 'before_state_id',
  'anchor', 'parser_verified', 'damage_kind', 'is_combat', 'first_strike', 'controller'];
const CARD_RULE_FIELDS = ['arena_id', 'name', 'display_name_zh', 'mana_cost', 'type_line', 'oracle_text', 'keywords', 'power', 'toughness',
  'source', 'certainty', 'missing_fields', 'metadata_complete', 'quality_warnings', 'colors', 'color_identity', 'layout'];
const FACE_RULE_FIELDS = ['name', 'display_name_zh', 'mana_cost', 'type_line', 'oracle_text', 'keywords', 'power', 'toughness', 'colors'];

function sanitizedCard(raw, names) {
  if (!plain(raw)) return raw == null ? raw : {};
  if (hidden(raw)) return { hidden: true };
  const card = copyKeys(raw, CARD_FIELDS);
  if (names.get(Number(card.arena_id))?.display_name_zh) card.display_name_zh = names.get(Number(card.arena_id)).display_name_zh;
  if (raw.counters) card.counters = Array.isArray(raw.counters)
    ? raw.counters.map(counter => copyKeys(counter, ['type', 'name', 'count', 'value', 'counterType', 'counterTypeId']))
    : Object.fromEntries(Object.entries(raw.counters).filter(([, count]) => typeof count === 'number'));
  if (raw.targets) card.targets = list(raw.targets).map(target => sanitizedTarget(target, names));
  if (raw.ability_source) card.ability_source = sanitizedCard(raw.ability_source, names);
  if (raw.source && plain(raw.source)) card.source = sanitizedCard(raw.source, names);
  return card;
}
function sanitizedTarget(raw, names) {
  if (raw?.player) return { player: ['me', 'opponent', 'both'].includes(raw.player) ? raw.player : 'unknown' };
  return sanitizedCard(raw, names);
}
function sanitizedEvent(raw, names) {
  const event = copyKeys(raw ?? {}, EVENT_FIELDS);
  const privateIdentity = hidden(raw?.card) || list(raw?.targets).some(hidden);
  const opponentDraw = event.actor === 'opponent' && /^(draw|drew|draw_card|card_drawn)$/.test(event.type);
  if (raw?.card && !hidden(raw.card) && !opponentDraw) event.card = sanitizedCard(raw.card, names);
  if (raw?.targets && !opponentDraw) event.targets = raw.targets.map(target => sanitizedTarget(target, names));
  if (privateIdentity || opponentDraw) delete event.details;
  if (raw?.life) event.life = copyKeys(raw.life, ['me', 'opponent']);
  if (!opponentDraw && raw?.source && plain(raw.source)) event.source = sanitizedCard(raw.source, names);
  if (!opponentDraw && raw?.ability_source) event.ability_source = sanitizedCard(raw.ability_source, names);
  if (raw?.damage_assignment) event.damage_assignment = list(raw.damage_assignment).map(value => copyKeys(value, ['source_instance_id', 'target_instance_id', 'player', 'amount', 'damage_kind']));
  return event;
}
const sanitizedNote = note => copyKeys(note, ['anchor', 'text', 'title', 'game_number']);
const sanitizedDecision = (value, names) => ({ ...copyKeys(value, ['type', 'candidate_only', 'anchor', 'details']),
  ...(value?.initial_hand ? { initial_hand: value.initial_hand.filter(card => !hidden(card)).map(card => sanitizedCard(card, names)) } : {}),
  ...(value?.bottomed_cards ? { bottomed_cards: value.bottomed_cards.filter(card => !hidden(card)).map(card => sanitizedCard(card, names)) } : {}) });

function sanitizedState(raw, names) {
  const state = copyKeys(raw, ['turn', 'phase', 'step', 'activePlayer', 'priorityPlayer', 'gameStateId']);
  state.players = {};
  for (const side of ['me', 'opponent']) {
    const player = raw?.players?.[side] ?? {};
    const clean = copyKeys(player, ['name', 'life', 'handSize', 'librarySize', 'mana_pool_source']);
    // Default opponent hand is count-only even if an unexpected caller supplies identities.
    clean.hand = side === 'me' ? list(player.hand).map(card => sanitizedCard(card, names)) : [];
    for (const zone of ['battlefield', 'graveyard', 'exile']) {
      clean[zone] = list(player[zone]).map(value => {
        const card = sanitizedCard(value, names);
        if (!card.hidden && zone === 'battlefield' && !own(card, 'controller')) card.controller = side;
        return card;
      });
    }
    // Preserve a recorded mana pool; do not substitute a computed available-mana count.
    for (const field of ['mana_pool', 'temporary_mana', 'mana']) {
      if (own(player, field) && player[field] === null) clean[field] = null;
      else if (plain(player[field])) clean[field] = Object.fromEntries(Object.entries(player[field]).filter(([, n]) => typeof n === 'number'));
      else if (Array.isArray(player[field])) clean[field] = player[field].map(value => copyKeys(value, ['color', 'amount', 'source_instance_id', 'restrictions']));
    }
    state.players[side] = clean;
  }
  state.stack = list(raw?.stack).map(card => sanitizedCard(card, names));
  state.warnings = list(raw?.warnings).filter(value => typeof value === 'string');
  return state;
}

function describeEvent(event, zh = false) {
  const actor = event.actor === 'me' ? (zh ? '我' : 'Me') : event.actor === 'opponent' ? (zh ? '对手' : 'Opponent') : (zh ? '未知玩家' : 'Unknown player');
  const name = card => card?.hidden ? (zh ? '未知牌' : 'unknown card') : (zh && card?.display_name_zh ? card.display_name_zh : card?.name ?? (zh ? '未知牌' : 'unknown card'));
  const card = name(event.card);
  const targets = list(event.targets).map(target => target.player === 'me' ? (zh ? '我' : 'Me') : target.player === 'opponent' ? (zh ? '对手' : 'Opponent') : name(target)).join(zh ? '、' : ', ');
  const target = targets ? ` → ${targets}` : '';
  const verbs = { cast: ['casts', '施放'], land: ['plays land', '使用地牌'], land_played: ['plays land', '使用地牌'],
    activate: ['activates', '启动异能'], trigger: ['triggers', '触发异能'], sacrifice: ['sacrifices', '牺牲'], discard: ['discards', '弃掉'], reveal: ['reveals', '展示'], mill: ['mills', '磨牌'] };
  if (verbs[event.type]) return `${actor} ${verbs[event.type][zh ? 1 : 0]} ${card}${target}`;
  if (event.type === 'draw') return event.actor === 'opponent' ? (zh ? `对手抓${event.amount ?? 1}张牌` : `Opponent draws ${event.amount ?? 1} card(s)`) : `${actor} ${zh ? '抓到' : 'draws'} ${event.card ? card : event.amount ?? 1}`;
  if (event.type === 'attack') return `${card} ${zh ? '攻击' : 'attacks'}${target}`;
  if (event.type === 'block') return `${card} ${zh ? '阻挡' : 'blocks'} ${targets || (zh ? '未知目标' : 'unknown target')}`;
  if (event.type === 'target') return `${card} ${zh ? '指定目标' : 'targets'}${target}`;
  if (event.type === 'damage') return `${event.card ? card : actor}${target}: ${event.amount ?? '?'} ${zh ? event.damage_kind === 'first_strike' ? '点先攻伤害' : '点伤害' : event.damage_kind === 'first_strike' ? 'first-strike damage' : 'damage'}`;
  if (event.type === 'life') return `${zh ? '生命' : 'Life'}: ${zh ? '我' : 'Me'} ${event.life?.me ?? '?'} · ${zh ? '对手' : 'Opponent'} ${event.life?.opponent ?? '?'}`;
  if (event.type === 'ability') return `${zh ? '来自' : 'Ability from'} ${card}${zh ? '的异能（启动／触发分类未知）' : ' (activation/trigger classification unknown)'}${target}`;
  const other = { enters: ['enters battlefield', '进入战场'], dies: ['dies', '死亡'], destroy: ['is destroyed', '被消灭'], exile: ['is exiled', '被放逐'], return: ['returns', '返回'], counter: ['counters change', '指示物改变'], token: ['token created', '产生衍生物'], resolve: ['resolves', '结算'] };
  if (other[event.type]) return `${card} ${other[event.type][zh ? 1 : 0]}${event.to ? ` → ${event.to}` : ''}${target}`;
  if (['phase', 'state'].includes(event.type)) return [event.phase, event.step].filter(Boolean).join(' · ') || (zh ? '状态更新' : 'State update');
  if (/mulligan/.test(event.type ?? '')) return zh ? '起手牌／再调度状态' : 'Opening hand / mulligan state';
  return `${actor}: ${event.type ?? 'state'}${event.card ? ` · ${card}` : ''}${target}`;
}

function stateOrder(states) {
  const entries = Object.entries(states).map(([id, value], index) => ({ id, value, index }));
  // Canonical S<n> ids follow recording chronology. A raw GRE gameStateId can reset.
  return entries.every(entry => /^S\d+$/.test(entry.id))
    ? entries.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
    : entries;
}
const identityKey = card => card?.logical_id ? `logical:${card.logical_id}:${card.arena_id ?? card.name}` : card?.instance_id != null ? `instance:${card.instance_id}:${card.arena_id ?? card.name}` : `card:${card?.arena_id ?? card?.name}`;
const entityKey = card => card?.logical_id ? `logical:${card.logical_id}` : card?.instance_id != null ? `instance:${card.instance_id}` : null;
const cardReference = card => copyKeys(card, ['name', 'display_name_zh', 'arena_id', 'instance_id', 'logical_id', 'controller', 'power', 'toughness', 'is_tapped', 'counters', 'is_token', 'damage', 'damage_marked', 'has_summoning_sickness', 'is_copy']);

function annotateState(state, { id, events, anchor, known, aliases, actorHints, rules }) {
  const observed = new Map();
  const resolvedKey = card => aliases.get(`${card?.instance_id}:${card?.arena_id ?? card?.name}`) ?? identityKey(card);
  const remember = (card, zone, observationSource) => {
    if (!card || card.hidden || !card.name) return;
    const key = card.logical_id ? identityKey(card) : resolvedKey(card);
    if (card.instance_id != null) aliases.set(`${card.instance_id}:${card.arena_id ?? card.name}`, key);
    const previous = known.get(key);
    if (observationSource === 'public_ability_source' && observed.has(key)) {
      previous.where_seen = unique([...previous.where_seen, zone]);
      return;
    }
    const publicAction = events.find(event => event.actor === 'opponent' && event.card?.instance_id === card.instance_id && event.card?.arena_id === card.arena_id);
    const value = { ...(previous ?? copyKeys(card, ['name', 'display_name_zh', 'arena_id', 'instance_id', 'logical_id'])), instance_id: card.instance_id ?? previous?.instance_id ?? null,
      first_revealed_anchor: previous ? previous.first_revealed_anchor : publicAction?.anchor ?? anchor ?? null,
      first_revealed_state_id: previous ? previous.first_revealed_state_id : id,
      where_seen: unique([...(previous?.where_seen ?? []), zone]), last_seen_state_id: id,
      last_public_location: zone, currently_hidden: false, current_public_location: zone,
      current_hidden_hand_identity_confirmed: false, observation_source: observationSource };
    known.set(key, value);
    if (observationSource !== 'public_action') observed.set(key, zone);
  };
  for (const event of events) {
    if (event.card && ['me', 'opponent'].includes(event.actor)) actorHints.set(event.card.instance_id, event.actor);
  }
  for (const side of ['me', 'opponent']) for (const zone of ['battlefield', 'graveyard', 'exile']) {
    for (const card of state.players[side][zone]) {
      if (card.hidden) continue;
      if (zone === 'battlefield') actorHints.set(card.instance_id, side);
      if (side === 'opponent') remember(card, zone, 'public_zone_snapshot');
    }
  }
  for (const card of state.stack) {
    if (card.hidden) continue;
    if (!card.controller && actorHints.has(card.instance_id)) { card.controller = actorHints.get(card.instance_id); card.controller_source = 'chronological_action_or_zone'; }
    card.stack_type = card.is_ability ? 'ability' : 'spell';
    if (card.controller === 'opponent') {
      if (card.is_ability) remember(card.ability_source, 'ability_source', 'public_ability_source');
      else remember(card, 'stack', 'public_stack_snapshot');
    }
  }
  for (const event of events) {
    if (event.actor === 'opponent' && event.card && event.type !== 'draw') {
      // An opponent draw identity was already removed. Public cast/reveal/zone-change events count.
      const zone = event.to ? String(event.to).toLowerCase() : event.type === 'cast' ? 'stack' : event.type === 'reveal' ? 'revealed' : 'public_action';
      const key = resolvedKey(event.card);
      if (!observed.has(key)) remember(event.card, zone, 'public_action');
      else known.get(key).where_seen = unique([...known.get(key).where_seen, zone]);
      if (/hand|library/.test(zone)) {
        const entry = known.get(resolvedKey(event.card)); entry.currently_hidden = true; entry.current_public_location = null;
        entry.last_observed_transition = { type: event.type, to: event.to, anchor: event.anchor ?? anchor ?? null };
      }
    }
  }
  for (const [key, entry] of known) if (!observed.has(key)) {
    entry.currently_hidden = true; entry.current_public_location = null;
  }
  state.known_opponent_information = { policy: 'Chronological public observations only. Prior identity knowledge does not establish a current hidden-hand identity.',
    known_opponent_cards: [...known.values()].map(value => structuredClone(value)) };
  state.priority = state.priorityPlayer ? { player: state.priorityPlayer, source: 'last_observed', confidence: 'limited' } : null;
  if (state.priority) state.warnings = unique([...state.warnings, PRIORITY_WARNING]);
  state.mana_sources = { me: [], opponent: [], available_mana: null,
    interpretation: 'Candidates from the observed battlefield and printed rules; no activation legality or usable-mana total is inferred.' };
  for (const side of ['me', 'opponent']) for (const card of state.players[side].battlefield) {
    if (card.hidden) continue;
    const rule = rules.get(Number(card.arena_id));
    const type = [list(card.card_types).join(' '), card.type_line, rule?.type_line].filter(Boolean).join(' ');
    const oracle = [rule?.oracle_text, ...list(rule?.card_faces).map(face => face.oracle_text)].filter(Boolean).join('\n');
    const reasons = [];
    if (/\bLand\b|CardType_Land/.test(type)) reasons.push('land');
    if (/\badd\s+(?:\{|one|two|three|[a-z]+ mana)/i.test(oracle)) reasons.push('printed_mana_ability');
    if (/\bTreasure\b/i.test(type)) reasons.push('treasure');
    if (/\bLander\b/i.test(type)) reasons.push('lander_land_search_resource');
    if (reasons.length) state.mana_sources[side].push({ ...cardReference(card), candidate_reasons: reasons, usable_now: null });
  }
  const battlefield = [...state.players.me.battlefield, ...state.players.opponent.battlefield].filter(card => !card.hidden);
  const attackers = battlefield.filter(card => card.is_attacking).map(card => {
    const blockers = battlefield.filter(blocker => list(blocker.blocked_attacker_ids).includes(card.instance_id));
    const target = card.attacking_target_id;
    const normalizedTarget = events.find(event => event.type === 'attack' && event.card?.instance_id === card.instance_id)?.targets?.[0];
    const defending = normalizedTarget ? { ...structuredClone(normalizedTarget), source: 'normalized_attack_event' }
      : target === 1 || target === 2 ? { player: card.controller === 'me' ? 'opponent' : card.controller === 'opponent' ? 'me' : null,
        source: 'opposing_controller_in_two_player_game' }
      : target != null ? { instance_id: target, ...(battlefield.find(value => value.instance_id === target) ? cardReference(battlefield.find(value => value.instance_id === target)) : {}), source: 'observed_object_target' } : null;
    const rule = rules.get(Number(card.arena_id));
    return { ...cardReference(card), raw_attacking_target_id: target ?? null, defending, blockers: blockers.map(cardReference),
      printed_combat_keywords: list(rule?.keywords).filter(keyword => /first strike|double strike|trample/i.test(keyword)),
      observed_combat_keywords: list(card.keywords).filter(keyword => /first strike|double strike|trample/i.test(keyword)) };
  });
  state.combat = { active: /combat/i.test(state.phase ?? ''), attackers,
    blockers: battlefield.filter(card => card.is_blocking || list(card.blocked_attacker_ids).length).map(card => ({ ...cardReference(card), blocked_attacker_ids: list(card.blocked_attacker_ids) })),
    damage_events: events.filter(event => event.type === 'damage').map(value => structuredClone(value)),
    death_events: events.filter(event => ['dies', 'destroy', 'sacrifice'].includes(event.type)).map(value => structuredClone(value)),
    damage_assignment: events.flatMap(event => list(event.damage_assignment)),
    interpretation: 'Relationships and damage are observed; printed keywords are static references, not proof an ability remained active.' };
}

function buildGame(raw, names, rules, number) {
  const game = copyKeys(raw, ['game_number', 'on_play']); game.game_number ??= number;
  game.starting_hand = list(raw.starting_hand).filter(card => !hidden(card)).map(card => sanitizedCard(card, names));
  game.mulligans = copyKeys(raw.mulligans, ['me', 'opponent']);
  game.decision_points = list(raw.decision_points).map(value => sanitizedDecision(value, names));
  game.result = { ...copyKeys(raw.result, ['outcome', 'reason']), ...(raw.result?.life ? { life: copyKeys(raw.result.life, ['me', 'opponent']) } : {}) };
  game.warnings = list(raw.warnings).filter(value => typeof value === 'string');
  game.evidence = copyKeys(raw.evidence, ['parser', 'own_draws_parsed', 'actions_parsed', 'board_snapshots_parsed']);
  game.states = Object.fromEntries(Object.entries(raw.states ?? {}).map(([id, value]) => [id, sanitizedState(value, names)]));
  game.steps = list(raw.steps ?? raw.replay_steps).map((step, index) => {
    const clean = copyKeys(step, ['anchor', 'turn', 'action', 'state_id', 'before_state_id', 'state_boundary', 'grouped_frame']);
    clean.event = sanitizedEvent(step.event ?? {}, names);
    clean.event.anchor ??= clean.anchor;
    clean.coachNotes = list(step.coachNotes).map(sanitizedNote);
    if (step.state && !clean.state_id) { clean.state_id = `INLINE_AFTER_${index + 1}`; game.states[clean.state_id] = sanitizedState(step.state, names); }
    if (step.state_before && !clean.before_state_id) { clean.before_state_id = `INLINE_BEFORE_${index + 1}`; game.states[clean.before_state_id] = sanitizedState(step.state_before, names); }
    clean.after_state_id = clean.state_id ?? null;
    clean.before_state_id ??= null;
    clean.actor = clean.event.actor ?? null;
    clean.phase = clean.event.phase ?? game.states[clean.state_id]?.phase ?? null;
    clean.step = clean.event.step ?? game.states[clean.state_id]?.step ?? null;
    clean.description_en = describeEvent(clean.event);
    clean.description_zh = describeEvent(clean.event, true);
    return clean;
  });
  game.turns = list(raw.turns).map(turn => ({ ...copyKeys(turn, ['turn_number', 'active_player']),
    events: list(turn.events).map(event => sanitizedEvent(event, names)),
    decision_points: list(turn.decision_points).map(value => sanitizedDecision(value, names)) }));
  const frames = new Map(), anchors = new Map();
  for (const step of game.steps) {
    if (step.state_id) { const frame = frames.get(step.state_id) ?? []; frame.push(step); frames.set(step.state_id, frame); if (!anchors.has(step.state_id)) anchors.set(step.state_id, step.anchor); }
    const missing = !game.states[step.state_id] || (step.before_state_id && !game.states[step.before_state_id]);
    step.certainty = { action: step.event.parser_verified ? 'parser_verified' : 'observed_or_reconstructed',
      before_state: step.before_state_id && game.states[step.before_state_id] ? 'observed_GRE_frame' : 'unknown',
      after_state: game.states[step.state_id] ? 'observed_GRE_frame' : 'unknown',
      intra_frame_order: 'not_observed', legality: 'not_evaluated' };
    if (missing) game.warnings.push(`Missing state reference at ${step.anchor ?? 'unknown anchor'}.`);
  }
  for (const steps of frames.values()) for (const step of steps) {
    step.grouped_frame = Boolean(step.grouped_frame || steps.length > 1);
    if (step.grouped_frame) { step.state_boundary = 'shared_GRE_frame'; game.warnings.push(SHARED_FRAME_WARNING); }
  }
  const known = new Map(), aliases = new Map(), actorHints = new Map();
  for (const { id, value: state } of stateOrder(game.states)) {
    annotateState(state, { id, events: (frames.get(id) ?? []).map(step => step.event), anchor: anchors.get(id), known, aliases, actorHints, rules });
  }
  const offered = []; let previous = '';
  for (const { id, value: state } of stateOrder(game.states)) {
    if (state.turn !== 0 || !state.players.me.hand.length) continue;
    const signature = JSON.stringify(state.players.me.hand.map(card => [card.arena_id, card.instance_id]));
    if (signature === previous) continue;
    previous = signature;
    offered.push({ state_id: id, anchor: anchors.get(id) ?? null, hand: structuredClone(state.players.me.hand), source: 'opening_state_observation' });
  }
  if (!offered.length) for (const decision of game.decision_points) if (decision.initial_hand?.length) offered.push({ state_id: null, anchor: decision.anchor ?? null, hand: decision.initial_hand, source: 'mulligan_candidate_record' });
  game.opening = { offered_hands: offered, first_offered_hand: offered[0]?.hand ?? null,
    kept_hand: structuredClone(game.starting_hand), mulligans: game.mulligans.me ?? null,
    bottomed_cards: raw.opening?.bottomed_cards ? list(raw.opening.bottomed_cards).filter(card => !hidden(card)).map(card => sanitizedCard(card, names)) : null,
    certainty: { offered_hands: offered.length ? 'observed_hands_not_inferred_rule_steps' : 'unknown', kept_hand: game.starting_hand.length ? 'canonical_starting_hand' : 'unknown', bottomed_cards: raw.opening?.bottomed_cards ? 'observed' : 'unknown' } };
  game.warnings = unique(game.warnings);
  return game;
}

/** Track JSON line ranges from the exact pretty representation used by the synchronizer. */
function readerIndex(coach, { expanded = coach, ranges = new Map(), parts = new Map() } = {}) {
  const lines = [], stateRanges = new Map(), actionRanges = new Map(), sectionRanges = new Map();
  const emit = (value, level, path, prefix = '', comma = '') => {
    const start = lines.length + 1, indent = '  '.repeat(level);
    if (Array.isArray(value) && value.length) {
      lines.push(indent + prefix + '[');
      value.forEach((child, i) => emit(child, level + 1, [...path, i], '', i < value.length - 1 ? ',' : ''));
      lines.push(indent + ']' + comma);
    } else if (plain(value) && Object.keys(value).length) {
      const entries = Object.entries(value).filter(([, child]) => child !== undefined);
      lines.push(indent + prefix + '{');
      entries.forEach(([key, child], i) => emit(child, level + 1, [...path, key], JSON.stringify(key) + ': ', i < entries.length - 1 ? ',' : ''));
      lines.push(indent + '}' + comma);
    } else lines.push(indent + prefix + JSON.stringify(value === undefined ? null : value) + comma);
    const range = { start_line: start, end_line: lines.length };
    if (path.length === 4 && path[0] === 'games' && path[2] === 'states') stateRanges.set(`${path[1]}:${path[3]}`, range);
    if (path.length === 4 && path[0] === 'games' && path[2] === 'steps') actionRanges.set(`${path[1]}:${path[3]}`, range);
    if (path.length === 3 && path[0] === 'games' && ['steps', 'turns', 'opening'].includes(path[2])) sectionRanges.set(`${path[1]}:${path[2]}`, range);
    if (path.length === 1 && path[0] === 'deck') sectionRanges.set('deck', range);
  };
  emit(coach, 0, []);
  if (lines.join('\n') + '\n' !== serializeCoachJson(coach)) throw new Error('Coach reader index does not match pretty JSON.');
  const partRanges = new Map([...ranges.values()].map(range => [range.key, range]));
  const dataRange = (key, fallback) => partRanges.get(key) ?? fallback ?? null;
  const chapters = (prefix, kind) => [...parts].filter(([, part]) => part.kind === kind).flatMap(([file, part]) => {
    const keys = Object.keys(part.records), selected = keys.map((key, i) => ({ key, i })).filter(({ key }) => key.startsWith(prefix));
    return selected.length ? [{ file, start_line: 5 + selected[0].i, end_line: 5 + selected.at(-1).i,
      first_record: selected[0].key, last_record: selected.at(-1).key, record_count: selected.length }] : [];
  });
  return { file: 'coach.json', line_count: lines.length, range_convention: '1-based inclusive', deck: sectionRanges.get('deck'),
    parts: coach.reference_encoding?.parts ?? [], games: expanded.games.map((game, gameIndex) => ({
    game_number: game.game_number,
    actions: sectionRanges.get(`${gameIndex}:steps`), turns: sectionRanges.get(`${gameIndex}:turns`), opening: sectionRanges.get(`${gameIndex}:opening`),
    action_parts: chapters(`G${gameIndex + 1}:`, 'actions'), turn_parts: chapters(`G${gameIndex + 1}:`, 'turns'),
    opening_data: dataRange(`G${gameIndex + 1}:opening`, sectionRanges.get(`${gameIndex}:opening`)),
    states: Object.fromEntries(Object.keys(game.states).map(id => [id, dataRange(`G${gameIndex + 1}:${id}`, stateRanges.get(`${gameIndex}:${id}`))])),
    anchors: Object.fromEntries(game.steps.map((step, i) => [step.anchor, { action: dataRange(`G${gameIndex + 1}:${step.anchor ?? i + 1}`, actionRanges.get(`${gameIndex}:${i}`)),
      before_state_id: step.before_state_id, after_state_id: step.after_state_id,
      before: dataRange(`G${gameIndex + 1}:${step.before_state_id}`, stateRanges.get(`${gameIndex}:${step.before_state_id}`)),
      after: dataRange(`G${gameIndex + 1}:${step.after_state_id}`, stateRanges.get(`${gameIndex}:${step.after_state_id}`)) }])) })) };
}

function allowedCardIds(value, output = new Set()) {
  if (!plain(value) && !Array.isArray(value)) return output;
  if (hidden(value)) return output;
  if (Number.isInteger(value.arena_id) && value.arena_id > 0) output.add(value.arena_id);
  for (const child of Object.values(value)) if (plain(child) || Array.isArray(child)) allowedCardIds(child, output);
  return output;
}

export async function buildCoachBundle(replay, { cards = [], generatedAt = new Date().toISOString(), historyKey: requestedHistoryKey,
  partitionBytes = 700 * 1024, multipart = 'auto' } = {}) {
  if (!replay?.match?.id || !replay.match.started_at) throw new Error('Coach Bundle requires match.id and match.started_at.');
  const stamp = new Date(replay.match.started_at).toISOString().replace(/[:.]/g, '-');
  const historyKey = requestedHistoryKey ?? `${stamp}_${encodeURIComponent(replay.match.id)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(historyKey)) throw new Error('Invalid Coach history key.');
  const metadata = await cards;
  const names = new Map(list(metadata).filter(card => !hidden(card)).map(card => [Number(card.arena_id), card]));
  const safeGames = list(replay.games).map((game, i) => buildGame(game, names, names, i + 1));
  const deck = list(replay.deck).filter(card => !hidden(card)).map(card => sanitizedCard(card, names));
  const safeMatch = copyKeys(replay.match, ['id', 'started_at', 'ended_at', 'event_id', 'event', 'format', 'is_jump_in', 'result', 'on_play', 'player', 'opponent', 'first_player', 'end_reason']);
  const expanded = { schema: 'MTGA_FULL_COACH_V1', schema_version: replay.schema_version ?? '1.0',
    perspective: { ...copyKeys(replay.perspective, ['policy', 'hidden_information', 'post_game_reveals']),
      static_card_dictionary: 'May contain cards revealed later; it is not evidence those identities were known at earlier anchors.',
      coach_notes: 'Post-game annotations are not in-game player knowledge.' },
    match: safeMatch, deck, games: safeGames,
    state_dictionary_scope: 'per_game',
    warnings: unique([...list(replay.warnings).filter(value => typeof value === 'string'),
      PRIORITY_WARNING, 'No unobserved legality, mana availability, hidden-hand identity, or exact intra-GRE intermediate board is inferred.']),
    coachNotes: list(replay.coachNotes).map(sanitizedNote) };
  const ids = allowedCardIds(expanded), cardRules = new Map();
  for (const raw of list(metadata)) {
    if (hidden(raw) || !ids.has(Number(raw.arena_id))) continue;
    const card = copyKeys(raw, CARD_RULE_FIELDS);
    if (raw.card_faces) card.card_faces = list(raw.card_faces).map(face => copyKeys(face, FACE_RULE_FIELDS));
    cardRules.set(Number(card.arena_id), card);
  }
  const rules = [...cardRules.values()].sort((a, b) => a.arena_id - b.arena_id);
  const finalGame = safeGames.at(-1), deckCount = deck.reduce((n, card) => n + Number(card.quantity ?? card.count ?? 0), 0);
  const sourceCoverage = { games: safeGames.length, states: safeGames.reduce((n, game) => n + Object.keys(game.states).length, 0),
    actions: safeGames.reduce((n, game) => n + game.steps.length, 0), own_hand_state_history: true,
    registered_deck_cards: deckCount, jump_in_deck_complete: safeMatch.is_jump_in ? deckCount === 40 : null,
    oracle_cards: rules.filter(card => card.oracle_text || list(card.card_faces).some(face => face.oracle_text)).length,
    card_metadata_count: rules.length, card_metadata_complete: rules.length === ids.size && rules.every(card => card.metadata_complete === true),
    intermediate_GRE_boards: 'not_observed', priority: 'last_observed_or_unknown' };
  Object.assign(expanded.match, { match_id: safeMatch.id, ended_at: safeMatch.ended_at ?? null,
    on_the_play: safeMatch.on_play ?? finalGame?.on_play ?? null,
    first_player: safeMatch.first_player ?? (typeof safeMatch.on_play === 'boolean' ? safeMatch.on_play ? 'me' : 'opponent' : null),
    final_life: finalGame?.result?.life ?? { me: null, opponent: null }, end_reason: safeMatch.end_reason ?? finalGame?.result?.reason ?? 'unknown',
    reconstruction_quality: { state_source: 'chronological_GRE_frames', action_source: 'canonical_reconstruction',
      intra_GRE_intermediate_states: 'not_observed', hidden_hand_identity: 'omitted', legality: 'not_evaluated' }, source_coverage: sourceCoverage });
  const summary = { schema: 'MTGA_COACH_SUMMARY_V1', match_id: safeMatch.id, started_at: safeMatch.started_at,
    mode: safeMatch.event ?? safeMatch.event_id ?? null, result: safeMatch.result ?? finalGame?.result?.outcome ?? null,
    on_the_play: safeMatch.on_play ?? finalGame?.on_play ?? null,
    turns: safeGames.reduce((n, game) => n + unique([...game.turns.map(turn => turn.turn_number), ...Object.values(game.states).map(state => state.turn)]).filter(turn => Number.isInteger(turn) && turn > 0).length, 0),
    actions: sourceCoverage.actions, states: sourceCoverage.states, games: safeGames.length, deck_cards: deckCount,
    final_life: finalGame?.result?.life ?? { me: null, opponent: null }, player: safeMatch.player ?? null, opponent: safeMatch.opponent ?? null,
    coach_file: 'coach.json', cards_file: 'cards.json', source_coverage: sourceCoverage };
  // Validate continuous semantic values before any structural string chunks can split them.
  validateBundleFiles(new Map([['latest/coach.json', serializeCoachJson(expanded)],
    ['latest/summary.json', serializeCoachJson(summary)], ['latest/cards.json', serializeCoachJson(rules)]]));
  const { coach, parts, ranges } = semanticMultipart(expanded, historyKey, { partitionBytes, multipart });
  const files = new Map([['summary.json', summary], ['coach.json', coach], ['cards.json', rules], ...parts]);
  const fileHashes = Object.fromEntries([...files].map(([name, value]) => [name, { sha256: sha256(serializeCoachJson(value)), bytes: Buffer.byteLength(serializeCoachJson(value), 'utf8') }]));
  const contentHash = sha256(serializeCoachJson(fileHashes));
  const manifest = { schema: 'MTGA_COACH_MANIFEST_V1', generated_at: generatedAt, match_id: safeMatch.id,
    schema_versions: { summary: summary.schema, coach: coach.schema, cards: 'MTGA_COACH_CARDS_V1' },
    generator: { name: packageInfo.name, version: packageInfo.version }, content_hash: contentHash,
    files: fileHashes, coach_sha256: fileHashes['coach.json'].sha256, cards_sha256: fileHashes['cards.json'].sha256,
    source_coverage: sourceCoverage, reader_index: readerIndex(coach, { expanded, ranges, parts }) };
  return { summary, coach, cards: rules, manifest, contentHash, historyKey, parts };
}
