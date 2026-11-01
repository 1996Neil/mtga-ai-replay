import { describeMatchMode } from '../../../src/match-mode.mjs';
import { normalizeCombatState } from '../../../src/combat-state.mjs';
import type { CardInstance, CanonicalEvent, CoachNote, DraftRun, GameState, HistoryMatch, ParsedMatch, PlayerState, ReplayStep, Zone } from '../types/game.ts';

type Json = Record<string, any>;
const arr = (value: unknown): Json[] => Array.isArray(value) ? value.filter(v => v && typeof v === 'object') : [];
const number = (value: unknown): number | undefined => {
  const raw = value && typeof value === 'object' ? (value as Json).value : value;
  return raw != null && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
};
const seat = (value: unknown): number => value === 'me' || value === 1 ? 1 : value === 'opponent' || value === 2 ? 2 : 0;
const hidden = (card: Json): boolean => card.hidden === true || /hidden|post.?game/i.test(String(card.visibility ?? ''));
const words = (value: unknown): string => String(value ?? '').replace(/^(Phase|Step|CardType|ZoneType)_/, '').replace(/([a-z])([A-Z])/g, '$1 $2');

export function normalizeCard(raw: Json, containingSeat: number, zoneId: number): CardInstance {
  const isHidden = hidden(raw);
  const id = number(raw.instance_id ?? raw.instanceId ?? raw.id) ?? 0;
  const counters = Array.isArray(raw.counters)
    ? Object.fromEntries(raw.counters.map((c: Json) => [String(c.name ?? c.type ?? c.counterType ?? c.counterTypeId ?? 'Unknown'), number(c.count ?? c.value) ?? 0]))
    : { ...(raw.counters ?? {}) };
  const types = isHidden ? [] : (raw.card_types ?? raw.cardTypes ?? []).map((type: string) => type.startsWith('CardType_') ? type : `CardType_${type}`);
  return {
    instanceId: id, grpId: isHidden ? 0 : number(raw.arena_id ?? raw.grpId ?? raw.arenaId) ?? 0,
    zoneId, ownerSeatId: seat(raw.owner) || containingSeat, controllerSeatId: seat(raw.controller) || containingSeat,
    cardTypes: types, name: isHidden ? undefined : raw.name, logicalId: raw.logical_id,
    isTapped: Boolean(raw.is_tapped ?? raw.isTapped),
    power: number(raw.power), toughness: number(raw.toughness), counters,
    ...normalizeCombatState(raw),
    exiledBy: !isHidden && raw.exiled_by && !hidden(raw.exiled_by) ? number(raw.exiled_by.instance_id) : undefined,
    exileSourceLogicalId: !isHidden && raw.exiled_by && !hidden(raw.exiled_by) ? raw.exiled_by.logical_id : undefined,
    attachedTo: raw.attached_to ?? raw.attachedTo, attachments: raw.attachments ?? [],
    targetIds: raw.target_ids ?? raw.targetIds ?? [],
    targets: arr(raw.targets).map(target => hidden(target) ? { hidden: true } : target),
    abilitySource: raw.ability_source && !hidden(raw.ability_source) ? raw.ability_source : undefined,
    visibility: isHidden ? 'hidden' : raw.visibility,
    manaCost: isHidden ? undefined : raw.mana_cost ?? raw.manaCost,
    typeLine: isHidden ? undefined : raw.type_line ?? raw.typeLine,
    objectType: raw.is_ability ? 'GameObjectType_Ability' : raw.is_token ?? raw.isToken ? 'GameObjectType_Token' : raw.object_type ?? raw.objectType ?? 'GameObjectType_Card',
    damage: number(raw.damage_marked ?? raw.damage),
  };
}

/** Resolve already-filtered snapshots to the upstream board model. No logs are parsed here. */
export function normalizeState(snapshot: Json, fallbackTurn = 0): GameState {
  const objects = new Map<number, CardInstance>();
  const zones = new Map<number, Zone>();
  const battlefieldByOwner: Record<number, CardInstance[]> = {};
  const handByOwner: Record<number, CardInstance[]> = {};
  const handHistoryByOwner: Record<number, CardInstance[]> = {};
  const graveyardByOwner: Record<number, CardInstance[]> = {};
  const exileObjects: CardInstance[] = [];
  const players: PlayerState[] = [];
  const sourcePlayers = snapshot.players ?? {};
  for (const [key, id] of [['me', 1], ['opponent', 2]] as const) {
    const p = sourcePlayers[key] ?? {};
    handHistoryByOwner[id] = key === 'opponent' ? arr(p.hand_history).filter(card => !hidden(card) && ['public','player_known'].includes(card.visibility)).map(card => normalizeCard(card,id,id*100+2)) : [];
    players.push({ systemSeatId: id, playerName: p.name ?? (id === 1 ? 'Me' : 'Opponent'),
      lifeTotal: number(p.life ?? p.lifeTotal) ?? null,
      handSize: number(p.handSize ?? p.hand_size) ?? null,
      librarySize: number(p.librarySize ?? p.library_size) ?? null });
    for (const [field, type, offset] of [
      ['battlefield', 'ZoneType_Battlefield', 1], ['hand', 'ZoneType_Hand', 2],
      ['graveyard', 'ZoneType_Graveyard', 3], ['exile', 'ZoneType_Exile', 4],
    ] as const) {
      const zoneId = id * 100 + offset;
      // Opponent inspection accepts only explicitly visible, current-frame cards
      // from the dedicated projection, never arbitrary/raw opponent hand data.
      const input = key === 'opponent' && field === 'hand'
        ? arr(p.revealed_hand).filter(card => !hidden(card) && ['public', 'player_known'].includes(card.visibility))
        : arr(p[field]);
      const cards = input.map((card, i) => {
        const value = normalizeCard(card, id, zoneId);
        if (!value.instanceId) value.instanceId = -(zoneId * 1000 + i + 1); // anonymous renderer key, never a game identity
        return value;
      });
      zones.set(zoneId, { zoneId, type, ownerSeatId: id, objectInstanceIds: cards.map(c => c.instanceId) });
      for (const card of cards) objects.set(card.instanceId, card);
      if (field === 'battlefield') battlefieldByOwner[id] = cards;
      if (field === 'hand') handByOwner[id] = cards;
      if (field === 'graveyard') graveyardByOwner[id] = cards;
      if (field === 'exile') exileObjects.push(...cards);
    }
  }
  const stackObjects = arr(snapshot.stack).map(card => normalizeCard(card, seat(card.controller ?? card.owner), 300));
  for (const card of stackObjects) objects.set(card.instanceId, card);
  zones.set(300, { zoneId: 300, type: 'ZoneType_Stack', objectInstanceIds: stackObjects.map(c => c.instanceId) });
  return {
    gameStateId: number(snapshot.gameStateId ?? snapshot.game_state_id) ?? 0,
    turnInfo: { turnNumber: number(snapshot.turn ?? snapshot.turn_number) ?? fallbackTurn,
      phase: String(snapshot.phase ?? ''), step: snapshot.step ?? '',
      activePlayer: seat(snapshot.activePlayer ?? snapshot.active_player),
      priorityPlayer: seat(snapshot.priorityPlayer ?? snapshot.priority_player) || undefined },
    players, zones, gameObjects: objects, annotations: [], battlefieldByOwner, handByOwner, handHistoryByOwner,
    graveyardByOwner, exileObjects, stackObjects,
    zoneTypeMap: new Map([...zones].map(([id, z]) => [id, z.type])),
  };
}

function safeEvent(raw: Json): CanonicalEvent {
  const result = { ...raw } as CanonicalEvent;
  const privateCard = raw.card && hidden(raw.card);
  const privateTarget = arr(raw.targets).some(hidden);
  if (privateCard || (raw.actor === 'opponent' && raw.type === 'draw')) delete result.card;
  result.targets = arr(raw.targets).map(target => hidden(target) ? { hidden: true } : target);
  if (privateCard || privateTarget || (raw.actor === 'opponent' && raw.type === 'draw')) delete result.details;
  return result;
}

const labelCard = (card?: Json): string => card && !hidden(card) ? String(card.name ?? `Card ${card.arena_id ?? '?'}`) : 'unknown card';
const labelActor = (actor?: string): string => actor === 'me' ? 'Me' : actor === 'opponent' ? 'Opponent' : actor === 'both' ? 'Life' : 'Unknown player';
export function describeEvent(event: CanonicalEvent): string {
  const actor = labelActor(event.actor), card = labelCard(event.card);
  const target = (event.targets ?? []).map(t => t.player ? labelActor(String(t.player)) : labelCard(t)).join(', ');
  switch (event.type) {
    case 'draw': return event.actor === 'opponent' ? `Opponent draws ${event.amount ?? 1} card` : `${actor} draws ${card}`;
    case 'cast': return `${actor} casts ${card}${target ? ` → ${target}` : ''}`;
    case 'land': case 'land_played': return `${actor} plays ${card}`;
    case 'enters': case 'entered_battlefield': return `${card} enters battlefield`;
    case 'attack': return `${card} attacks${target ? ` → ${target}` : ''}`;
    case 'block': return `${card} blocks${target ? ` ${target}` : ''}`;
    case 'attack_selection': case 'block_selection': return `${actor} selects ${card} to ${event.type === 'attack_selection' ? 'attack' : 'block'}${target ? ` → ${target}` : ''} (unconfirmed)`;
    case 'attack_selection_cancelled': case 'block_selection_cancelled': return `${actor} cancels ${card}'s combat selection`;
    case 'target': return `${card} targets ${target || 'unknown target'}`;
    case 'damage': return `${event.card ? card : actor} → ${target || '?'}: ${event.amount ?? '?'} damage`;
    case 'life': case 'life_changed': return `Life — Me ${event.life?.me ?? '?'} · Opponent ${event.life?.opponent ?? '?'}`;
    case 'destroy': case 'destroyed': case 'dies': return `${card} dies${event.details ? ` (${words(event.details)})` : ''}`;
    case 'put_into_graveyard': return `${card} is put into graveyard${event.details ? ` (${words(event.details)})` : ''}`;
    case 'exile': return `${card} is exiled`;
    case 'sacrifice': return `${actor} sacrifices ${card}`;
    case 'discard': return `${actor} discards ${card}`;
    case 'resolve': return `${card} resolves`;
    case 'return': return `${card} returns to ${words(event.to) || 'hand'}`;
    case 'activate': return `${actor} activates ${card}`;
    case 'trigger': return `${card} triggers`;
    case 'ability': return `Ability created from ${card} (classification unknown)`;
    case 'counter': return `${card}: ${event.details || 'counters changed'}${event.amount != null ? ` (${event.amount})` : ''}`;
    case 'state': case 'phase': return `${words(event.phase) || 'State'}${event.step ? ` · ${words(event.step)}` : ''}`;
    case 'game_over': return 'Game over (terminal snapshot)';
    case 'mulligan': return `${actor} mulligan decision`;
    case 'mulligan_state': return 'My opening hand / mulligan state';
    case 'reveal': return `${actor} reveals ${card}`;
    default: return `${actor}: ${words(event.type) || 'State recorded'}${event.card ? ` · ${card}` : ''}${event.details ? ` · ${event.details}` : ''}`;
  }
}

export function normalizeReplay(raw: Json): ParsedMatch[] {
  const meta = raw.match ?? {};
  return arr(raw.games).map((game, gameIndex) => {
    const gameNumber = game.game_number ?? gameIndex + 1;
    const states = game.states ?? {};
    const sourceSteps = arr(game.steps);
    const usage = new Map<string, number>();
    for (const step of sourceSteps) if (step.state_id) usage.set(step.state_id, (usage.get(step.state_id) ?? 0) + 1);
    const steps: ReplayStep[] = sourceSteps.map((step, stepIndex) => {
      const event = safeEvent(step.event ?? {});
      const snapshot = step.state ?? states[step.state_id] ?? {};
      const before = step.state_before ?? states[step.before_state_id];
      const turn = number(step.turn ?? step.turn_number) ?? number(snapshot.turn) ?? 0;
      const notes = [...arr(step.coachNotes), ...arr(raw.coachNotes).filter(note => note.anchor === step.anchor && (note.game_number == null || Number(note.game_number) === Number(gameNumber)))];
      const coachNotes: CoachNote[] = [...new Map(notes.map(note => {
        const normalized = { anchor: note.anchor ?? step.anchor, text: note.text ?? note.body ?? '', title: note.title };
        return [JSON.stringify(normalized), normalized] as const;
      })).values()];
      return {
        stepIndex, turnNumber: turn, phase: snapshot.phase ?? '', step: snapshot.step ?? '',
        label: describeEvent(event), anchor: step.anchor ?? `T${turn}-A${stepIndex + 1}`,
        actionNumber: number(step.action) ?? 0, event,
        gameState: normalizeState(snapshot, turn), beforeGameState: before ? normalizeState(before, turn) : undefined,
        eventsSinceLastStep: [], stateId: step.state_id,
        groupedFrame: (usage.get(step.state_id) ?? 0) > 1,
        coachNotes,
        warnings: (snapshot.warnings ?? []).map(String),
      };
    });
    const cards = steps.flatMap(s => [...s.gameState.gameObjects.values()]);
    return { matchId: String(meta.id ?? raw.id ?? ''), gameNumber,
      players: [{ systemSeatId: 1, playerName: String(meta.player ?? 'Me') }, { systemSeatId: 2, playerName: String(meta.opponent ?? 'Opponent') }],
      localSeatId: 1, steps, grpIds: new Set(cards.map(c => c.grpId).filter(Boolean)),
      startedAt: String(meta.started_at ?? ''), eventName: describeMatchMode(meta).event,
      outcome: game.result?.outcome ?? meta.result,
      warnings: [...(raw.warnings ?? []), ...(game.warnings ?? [])].map(String),
    };
  });
}

export function normalizeHistory(raw: unknown): HistoryMatch[] {
  const data = Array.isArray(raw) ? raw : (raw as Json)?.matches ?? [];
  return arr(data).map(item => {
    const m = item.match ?? item;
    return { id: String(m.id ?? m.match_id), startedAt: String(m.started_at ?? m.startedAt ?? ''),
      event: describeMatchMode(m).event, result: String(m.result ?? 'Unknown'), gameCount: item.game_count, revision: String(item.replay_revision ?? item.updated_at ?? JSON.stringify(item)) };
  });
}

export function coachContext(match: ParsedMatch, step: ReplayStep, before: boolean): Json {
  const actualBefore = before && Boolean(step.beforeGameState);
  const s = actualBefore ? step.beforeGameState! : step.gameState;
  const card = (c: CardInstance) => c.visibility === 'hidden' ? { hidden: true } : ({ name: c.name, arena_id: c.grpId, instance_id: c.instanceId,
    logical_id: c.logicalId, visibility: c.visibility, is_tapped: c.isTapped, power: c.power,
    toughness: c.toughness, counters: c.counters, is_attacking: c.isAttacking,
    is_blocking: c.isBlocking, blocked_attacker_ids: c.blockedAttackerIds,
    is_blocked: c.isBlocked, attack_state: c.attackState, block_state: c.blockState,
    attacking_target_id: c.attackingTargetId, damage_marked: c.damage,
    attached_to: c.attachedTo, attachments: c.attachments, targets: c.targets, ability_source: c.abilitySource, is_ability: c.objectType === 'GameObjectType_Ability' });
  const player = (id: number) => {
    const p = s.players.find(p => p.systemSeatId === id)!;
    return { name: p.playerName, life: p.lifeTotal, handSize: p.handSize,
      hand: id === 1 ? (s.handByOwner[id] ?? []).map(card) : [],
      battlefield: (s.battlefieldByOwner[id] ?? []).map(card), graveyard: (s.graveyardByOwner[id] ?? []).map(card),
      exile: s.exileObjects.filter(c => c.ownerSeatId === id).map(card) };
  };
  return { schema_version: 'coach-context/1.0', match_id: match.matchId, game_number: match.gameNumber,
    anchor: step.anchor,
    event: actualBefore ? { type: step.event?.type, actor: step.event?.actor } : step.event,
    state_boundary: actualBefore ? 'before_gre_message' : 'after_gre_message',
    grouped_frame: step.groupedFrame, perspective: 'Use only information available to Me at this point. Do not infer legality or hidden identities.',
    state: { turn: s.turnInfo.turnNumber, phase: s.turnInfo.phase, step: s.turnInfo.step,
      activePlayer: s.turnInfo.activePlayer === 1 ? 'me' : s.turnInfo.activePlayer === 2 ? 'opponent' : null,
      priorityPlayer: s.turnInfo.priorityPlayer === 1 ? 'me' : s.turnInfo.priorityPlayer === 2 ? 'opponent' : null,
      players: { me: player(1), opponent: player(2) }, stack: s.stackObjects.map(card) }, warnings: step.warnings };
}


export function normalizeDraftRuns(raw: unknown): DraftRun[] {
  const data = Array.isArray(raw) ? raw : [];
  return arr(data).filter(item => typeof item.run_id === 'string' && typeof item.event === 'string').map(item => ({
    run_id: String(item.run_id), event_id: String(item.event_id ?? ''), event: String(item.event),
    capture_source: item.capture_source === '17lands-local-log' ? item.capture_source : undefined,
    binding: ['unresolved', 'matched_pool'].includes(item.binding) ? item.binding : undefined,
    bound_run_id: typeof item.bound_run_id === 'string' && /^[a-f0-9]{32}$/.test(item.bound_run_id) ? item.bound_run_id : undefined,
    binding_method: item.binding_method === 'exact_card_pool' ? item.binding_method : undefined,
    binding_reason: ['incomplete_picks', 'missing_course', 'ambiguous_courses', 'missing_matches', 'evidence_unavailable', 'awaiting_match_upload'].includes(item.binding_reason) ? item.binding_reason : undefined,
    binding_card_count: Number.isSafeInteger(item.binding_card_count) && item.binding_card_count > 0 ? item.binding_card_count : undefined,
    binding_pending_matches: Number.isSafeInteger(item.binding_pending_matches) && item.binding_pending_matches >= 0 ? item.binding_pending_matches : undefined,
    binding_account_status: ['matched', 'conflict', 'unknown'].includes(item.binding_account_status) ? item.binding_account_status : undefined,
    binding_account_key: typeof item.binding_account_key === 'string' && /^[a-f0-9]{64}$/.test(item.binding_account_key) ? item.binding_account_key : undefined,
    ownership_corrected: item.ownership_corrected === true,
    capture_run_ids: Array.isArray(item.capture_run_ids) ? item.capture_run_ids.filter((id: unknown) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)) : undefined,
    current_module: typeof item.current_module === 'string' ? item.current_module : null,
    started_at: typeof item.started_at === 'string' ? item.started_at : null,
    status: ['in_progress', 'completed'].includes(item.status) ? item.status : 'incomplete',
    score_verified: item.score_verified === true,
    replay_wins: Number.isSafeInteger(item.replay_wins) && item.replay_wins >= 0 ? item.replay_wins : 0,
    replay_losses: Number.isSafeInteger(item.replay_losses) && item.replay_losses >= 0 ? item.replay_losses : 0,
    course_wins: Number.isSafeInteger(item.course_wins) ? item.course_wins : null,
    course_losses: Number.isSafeInteger(item.course_losses) ? item.course_losses : null,
    colors: (Array.isArray(item.colors) ? item.colors : []).map(color => String(color)).filter(color => ['W','U','B','R','G'].includes(color)),
    colors_complete: item.colors_complete === true,
    card_pool: arr(item.card_pool).map(card => ({
      arena_id: Number.isSafeInteger(card.arena_id) ? card.arena_id : 0,
      name: typeof card.name === 'string' ? card.name : '未知牌',
    })).filter(card => card.arena_id > 0),
    matches: arr(item.matches).filter(match => typeof match.id === 'string').map(match => ({
      id: String(match.id), started_at: String(match.started_at ?? ''),
      account_key: typeof match.account_key === 'string' && /^[a-f0-9]{64}$/.test(match.account_key) ? match.account_key : undefined,
      binding_evidence: match.binding_evidence === 'course_context_and_main_deck' ? match.binding_evidence : undefined,
      result: typeof match.result === 'string' ? match.result : null,
      game_count: Number.isSafeInteger(match.game_count) && match.game_count > 0 ? match.game_count : null,
    })),
    picks: arr(item.picks).map(pick => ({
      pack_number: Number.isSafeInteger(pick.pack_number) ? pick.pack_number : 0,
      pick_number: Number.isSafeInteger(pick.pick_number) ? pick.pick_number : 0,
      picked_at: typeof pick.picked_at === 'string' ? pick.picked_at : null,
      candidates: arr(pick.candidates).map(card => ({ arena_id: Number.isSafeInteger(card.arena_id) ? card.arena_id : 0, name: typeof card.name === 'string' ? card.name : '未知牌' })).filter(card => card.arena_id > 0),
      selected: pick.selected && Number.isSafeInteger(pick.selected.arena_id) ? { arena_id: pick.selected.arena_id, name: String(pick.selected.name ?? '未知牌') } : null,
      pool_before: arr(pick.pool_before).map(card => ({ arena_id: Number.isSafeInteger(card.arena_id) ? card.arena_id : 0, name: typeof card.name === 'string' ? card.name : '未知牌' })).filter(card => card.arena_id > 0),
      pool_after: arr(pick.pool_after).map(card => ({ arena_id: Number.isSafeInteger(card.arena_id) ? card.arena_id : 0, name: typeof card.name === 'string' ? card.name : '未知牌' })).filter(card => card.arena_id > 0),
      complete: pick.complete === true, missing: (Array.isArray(pick.missing) ? pick.missing : []).map(String),
    })),
  }));
}
