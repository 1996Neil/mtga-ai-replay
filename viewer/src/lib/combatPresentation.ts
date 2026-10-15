import type { CanonicalEvent, CardInstance, GameState, ReplayStep } from '../types/game.ts';

export type CombatEndpoint = { card: number } | { player: number };
export interface CombatLink { from: CombatEndpoint; to: CombatEndpoint; kind: 'attack' | 'block'; }
export interface CombatMark { text: string; detail: string; attacking: boolean; blocking: boolean; }
const hidden = (card: { visibility?: string; hidden?: unknown }) => card.hidden === true || /hidden|post.?game/i.test(card.visibility ?? '');

interface CombatDisplayOptions {
  attackTargets?: ReadonlyMap<number, Record<string, unknown>>;
  displayName?: (card: CardInstance) => string | undefined;
}

/** Use only already observed attacks in this continuous combat, never a later frame. */
export function observedAttackTargets(steps: readonly ReplayStep[], current: ReplayStep, before = false) {
  const result = new Map<number, Record<string, unknown>>();
  const state = before && current.beforeGameState ? current.beforeGameState : current.gameState;
  if (state.turnInfo.phase !== 'Phase_Combat') return result;
  const index = steps.indexOf(current);
  if (index < 0) return result;
  let last = index - (before ? 1 : 0);
  if (before) {
    // A grouped GRE frame can emit several actions sharing the same after-state.
    // None of those actions belong in that frame's before-state, even if their
    // UI rows precede the current one.
    while (last >= 0 && current.stateId && steps[last].stateId === current.stateId) last--;
    if (state.gameStateId > 0) while (last >= 0 && steps[last].gameState.gameStateId > state.gameStateId) last--;
  }
  let start = last;
  const sameCombat = (s: GameState) => s.turnInfo.phase === 'Phase_Combat' && s.turnInfo.turnNumber === state.turnInfo.turnNumber;
  while (start >= 0 && sameCombat(steps[start].gameState)) start--;
  const observations = new Map<number, { card: CardInstance; target: Record<string, unknown> }>();
  const sameAttacker = (a: CardInstance, b: CardInstance) => !hidden(b) && b.isAttacking && a.grpId === b.grpId &&
    a.logicalId === b.logicalId && (a.attackingTargetId ?? null) === (b.attackingTargetId ?? null);
  for (let i = start + 1; i <= last; i++) {
    const frame = steps[i].gameState;
    const field = new Map(Object.values(frame.battlefieldByOwner).flat().map(c => [c.instanceId, c]));
    for (const [id, seen] of observations) {
      const card = field.get(id);
      if (!card || !sameAttacker(seen.card, card)) observations.delete(id);
    }
    const event = steps[i].event;
    if (event?.type !== 'attack') continue;
    const id = Number(event.card?.instance_id ?? event.card?.instanceId), card = field.get(id);
    if (!card || hidden(event.card ?? {}) || hidden(card) || !card.isAttacking) {
      // An anonymous attack must not let a previous semantic target reappear.
      observations.clear(); continue;
    }
    const target = event.targets?.length === 1 ? event.targets[0] : { hidden: true };
    observations.set(id, { card, target: hidden(target) ? { hidden: true } : target });
  }
  for (const card of Object.values(state.battlefieldByOwner).flat()) {
    const seen = observations.get(card.instanceId);
    if (seen && sameAttacker(seen.card, card)) result.set(card.instanceId, seen.target);
  }
  return result;
}

/** Presentation only. No inferred opponents or duplicated card instances. */
export function combatPresentation(state: GameState, localSeat: number, event?: CanonicalEvent, options: CombatDisplayOptions = {}) {
  const marks = new Map<number, CombatMark>();
  const links: CombatLink[] = [];
  if (state.turnInfo.phase !== 'Phase_Combat') return { marks, links, attackers: 0, blockers: 0 };
  const field = new Map(Object.values(state.battlefieldByOwner).flat().map(card => [card.instanceId, card]));
  const attackers = [...field.values()].filter(card => card.isAttacking).sort((a, b) => a.instanceId - b.instanceId);
  const labels = new Map(attackers.map((card, index) => [card.instanceId, `A${index + 1}`]));
  const blocking = [...field.values()].filter(card => card.isBlocking || card.blockedAttackerIds?.length);
  const opponent = state.players.find(player => player.systemSeatId !== localSeat)?.systemSeatId;
  function endpoint(id: number): CombatEndpoint | undefined {
    const card = field.get(id);
    if (card && !hidden(card)) return { card: id };
    // Canonical snapshots retain raw Arena player IDs while the UI uses me=1/opponent=2.
    // Without an explicit seat map, numeric player targets cannot be safely resolved.
  }
  function target(card: CardInstance): CombatEndpoint | undefined {
    const currentAttack = event?.type === 'attack' && Number(event.card?.instance_id ?? event.card?.instanceId) === card.instanceId;
    // Explicit redaction takes precedence over raw IDs retained by older adapters.
    if (currentAttack && (hidden(event?.card ?? {}) || event?.targets?.some(hidden))) return;
    // A resolved permanent remains authoritative. An unresolved raw ID must not
    // discard the matching current event's explicit me/opponent semantics.
    const observed = options.attackTargets?.get(card.instanceId);
    if (observed && hidden(observed)) return;
    const recorded = card.attackingTargetId != null && Number(card.attackingTargetId) > 2 ? endpoint(Number(card.attackingTargetId)) : undefined;
    if (recorded) return recorded;
    const raw = currentAttack && event?.targets?.length === 1 ? event.targets[0] : observed;
    if (!raw) return;
    if (hidden(raw)) return;
    if (raw.player === 'me') return { player: localSeat };
    if (raw.player === 'opponent' && opponent != null) return { player: opponent };
    return endpoint(Number(raw.instance_id ?? raw.instanceId));
  }
  function targetName(to?: CombatEndpoint) {
    if (!to) return '目标未知';
    if ('player' in to) return to.player === localSeat ? '我' : '对手';
    const card = field.get(to.card);
    return card && !hidden(card) ? options.displayName?.(card) || card.name || '已记录永久物' : '已记录永久物';
  }
  for (const card of attackers) {
    const label = labels.get(card.instanceId)!;
    const to = target(card);
    const blockers = blocking.filter(blocker => blocker.blockedAttackerIds?.includes(card.instanceId));
    const detail = `${label} 攻击 → ${targetName(to)}；${blockers.length ? `${blockers.length} 个阻挡者` : '尚无已记录阻挡者'}`;
    marks.set(card.instanceId, { text: to ? '' : '攻击目标未知', detail, attacking: true, blocking: false });
    if (to && !hidden(card)) links.push({ from: { card: card.instanceId }, to, kind: 'attack' });
  }
  for (const card of blocking) {
    const ids = [...new Set(card.blockedAttackerIds ?? [])];
    const known = ids.flatMap(id => {
      if (!labels.has(id)) return [];
      const attacker = field.get(id)!;
      return [hidden(attacker) ? '已记录攻击者' : options.displayName?.(attacker) || attacker.name || `攻击者 ${labels.get(id)!.slice(1)}`];
    });
    const missing = ids.length - known.length;
    const text = `阻挡 ${known.join(' / ') || '目标未知'}${missing ? ` + ${missing} 未知` : ''}`;
    const previous = marks.get(card.instanceId);
    marks.set(card.instanceId, { text: previous?.text ? `${previous.text}；${text}` : text,
      detail: previous ? `${previous.detail}；${text}` : text, attacking: !!previous?.attacking, blocking: true });
    // Iterate edges, not card views: one blocker can link to every observed attacker.
    for (const id of ids) if (labels.has(id) && !hidden(card) && !hidden(field.get(id)!)) {
      links.push({ from: { card: card.instanceId }, to: { card: id }, kind: 'block' });
    }
  }
  return { marks, links, attackers: attackers.length, blockers: blocking.length };
}
