// Visual projection of the existing chronological PerspectiveState. This module
// has no log reader/parser of its own and never resolves a future identity.
const has = (a, type) => (Array.isArray(a.type) ? a.type : [a.type]).includes(`AnnotationType_${type}`);
const detail = (a, key) => {
  const d = a.details?.find(d => d.key === key);
  return (d?.valueInt32 ?? d?.valueString ?? [])[0];
};
const numeric = value => typeof value === 'object' ? value?.value : value;

export function prepareVisualState(state, gsm) {
  state.logicalIds ??= new Map(); state.counterCounts ??= new Map(); state.persistent ??= new Map();
  if (gsm.type === 'GameStateType_Full') { state.counterCounts.clear(); state.persistent.clear(); }
  const oldTurn = state.turn.turnNumber;
  const newTurn = gsm.turnInfo?.turnNumber;
  const endCombat = gsm.turnInfo?.step === 'Step_EndCombat' || /^Phase_Main2$/.test(gsm.turnInfo?.phase ?? '');
  if ((newTurn !== undefined && oldTurn !== undefined && newTurn !== oldTurn) || endCombat) {
    for (const object of state.objects.values()) {
      delete object.attackInfo; delete object.blockInfo;
      object.attackState = 'AttackState_None'; object.blockState = 'BlockState_None';
    }
  }
  for (const a of gsm.annotations ?? []) if (has(a, 'ObjectIdChanged')) {
    const oldId = detail(a, 'orig_id'), newId = detail(a, 'new_id');
    if (typeof oldId !== 'number' || typeof newId !== 'number') continue;
    const logical = state.logicalIds.get(oldId) ?? `C${oldId}`;
    state.logicalIds.set(oldId, logical); state.logicalIds.set(newId, logical);
    if (state.counterCounts.has(oldId)) state.counterCounts.set(newId, { ...state.counterCounts.get(oldId) });
  }
}

export function updateVisualState(state, gsm) {
  function removeCounterSnapshot(annotation) {
    if (!annotation || !has(annotation, 'Counter')) return;
    const counter = detail(annotation, 'counter_type');
    for (const affected of annotation.affectedIds ?? []) {
      const logical = state.logicalIds.get(affected);
      for (const [id, counts] of state.counterCounts) {
        if (id === affected || (logical && state.logicalIds.get(id) === logical)) delete counts[counter];
      }
    }
  }
  for (const id of gsm.diffDeletedPersistentAnnotationIds ?? []) {
    removeCounterSnapshot(state.persistent.get(id)); state.persistent.delete(id);
  }
  for (const a of gsm.persistentAnnotations ?? []) {
    const previous = state.persistent.get(a.id);
    if (previous && (detail(previous, 'counter_type') !== detail(a, 'counter_type') ||
        JSON.stringify(previous.affectedIds) !== JSON.stringify(a.affectedIds))) removeCounterSnapshot(previous);
    state.persistent.set(a.id, a);
  }
  for (const object of state.objects.values()) {
    if (!state.logicalIds.has(object.instanceId)) state.logicalIds.set(object.instanceId, `C${object.instanceId}`);
  }
  for (const a of gsm.annotations ?? []) {
    if (has(a, 'TappedUntappedPermanent')) {
      const tapped = detail(a, 'tapped');
      if (tapped === 0 || tapped === 1) for (const id of a.affectedIds ?? []) {
        const object = state.objects.get(id); if (object) object.isTapped = tapped === 1;
      }
    }
    if (has(a, 'CounterAdded') || has(a, 'CounterRemoved')) {
      const counter = detail(a, 'counter_type'), amount = detail(a, 'transaction_amount');
      if (typeof counter !== 'number' || typeof amount !== 'number') continue;
      for (const id of a.affectedIds ?? []) {
        const counters = state.counterCounts.get(id) ?? {};
        counters[counter] = Math.max(0, (counters[counter] ?? 0) + (has(a, 'CounterRemoved') ? -Math.abs(amount) : amount));
        state.counterCounts.set(id, counters);
      }
    }
  }
  // Persistent Counter is the server's absolute count, not another increment.
  // Only a newly observed snapshot supersedes transaction deltas. Reapplying an
  // old cached annotation would erase CounterAdded/Removed in later messages.
  for (const a of gsm.persistentAnnotations ?? []) if (has(a, 'Counter')) {
    const counter = detail(a, 'counter_type'), count = detail(a, 'count');
    if (typeof counter !== 'number' || typeof count !== 'number') continue;
    for (const id of a.affectedIds ?? []) {
      const counters = state.counterCounts.get(id) ?? {}; counters[counter] = count;
      state.counterCounts.set(id, counters);
    }
  }
}

export function visualSnapshot(state, names, { me = 'Me', opponent = 'Opponent', counterNames = new Map(), gameStateId } = {}) {
  const role = seat => ![1, 2].includes(seat) ? null : seat === state.localSeat ? 'me' : 'opponent';
  const attachments = new Map();
  for (const a of state.persistent?.values() ?? []) if (has(a, 'Attachment')) {
    const host = a.affectedIds?.[0];
    if (state.card(a.affectorId, names) && state.card(host, names)) attachments.set(a.affectorId, host);
  }
  const targetMap = new Map();
  for (const a of state.persistent?.values() ?? []) if (has(a, 'TargetSpec')) {
    const targets = targetMap.get(a.affectorId) ?? [];
    for (const id of a.affectedIds ?? []) targets.push(state.target(id, names));
    targetMap.set(a.affectorId, targets);
  }
  function card(id) {
    const object = state.objects.get(id); if (!object) return null;
    let identity = state.card(id, names);
    if (!identity) return { instance_id: id, name: 'Face-down / unknown card', visibility: 'hidden', is_face_down: true };
    const isAbility = object.type === 'GameObjectType_Ability';
    let abilitySource;
    if (isAbility) {
      const source = state.card(object.parentId, names);
      const sourceObject = state.objects.get(object.parentId);
      // Resolve only the source currently visible in the accumulated GRE state.
      // A future reveal cannot name a hidden/missing source in an earlier frame.
      abilitySource = source ? { ...source, logical_id: state.logicalIds.get(object.parentId) ?? `C${object.parentId}`,
        owner: role(sourceObject?.ownerSeatId), controller: role(sourceObject?.controllerSeatId) } : { hidden: true };
      identity = source ? { ...source, instance_id: id, name: `${source.name} — ability` } :
        { instance_id: id, name: 'Unknown ability', visibility: identity.visibility };
    }
    const counters = Object.entries(state.counterCounts.get(id) ?? object.counters ?? {})
      .filter(([, count]) => Number(count) > 0)
      .map(([type, count]) => ({ type: Number(type), name: counterNames.get(Number(type)) ?? `Counter ${type}`, count }));
    return { ...identity, logical_id: state.logicalIds.get(id) ?? `C${id}`,
      owner: role(object.ownerSeatId), controller: role(object.controllerSeatId),
      ...(isAbility ? { ability_source: abilitySource } : {}),
      card_types: (object.cardTypes ?? []).map(type => type.replace('CardType_', '')),
      is_tapped: object.isTapped ?? object.status === 'StatusType_Tapped',
      is_token: object.type === 'GameObjectType_Token', is_ability: isAbility,
      power: numeric(object.power) ?? null, toughness: numeric(object.toughness) ?? null,
      damage_marked: numeric(object.damage) ?? null,
      has_summoning_sickness: object.hasSummoningSickness ?? null,
      is_copy: object.isCopy ?? null,
      colors: Array.isArray(object.color) ? object.color.map(color => color.replace('CardColor_', '')) : [],
      counters, is_attacking: ['AttackState_Declared', 'AttackState_Attacking'].includes(object.attackState),
      attacking_target_id: object.attackInfo?.targetId ?? null,
      is_blocking: (object.blockInfo?.attackerIds?.length ?? 0) > 0,
      blocked_attacker_ids: [...(object.blockInfo?.attackerIds ?? [])],
      attached_to: attachments.get(id) ?? null,
      attachments: [...attachments].filter(([, host]) => host === id).map(([attached]) => attached),
      targets: targetMap.get(id) ?? [],
    };
  }
  const players = {};
  const seats = [...state.players.keys()];
  if (!seats.includes(state.localSeat)) seats.push(state.localSeat);
  const otherSeat = seats.find(seat => seat !== state.localSeat) ?? (state.localSeat === 1 ? 2 : 1);
  for (const seat of [state.localSeat, otherSeat]) {
    const playerRole = role(seat);
    const zones = [...state.zones.values()];
    const zoneFor = type => zones.find(zone => zone.type === `ZoneType_${type}` && zone.ownerSeatId === seat);
    const zoneCards = type => {
      const zone = zoneFor(type);
      return (zone?.objectInstanceIds ?? []).map(card).filter(Boolean);
    };
    const battlefield = zones.filter(zone => zone.type === 'ZoneType_Battlefield')
      .flatMap(zone => (zone.objectInstanceIds ?? []).filter(id => {
        const object = state.objects.get(id); return (object?.controllerSeatId ?? object?.ownerSeatId) === seat;
      })).map(card).filter(Boolean);
    const observedMana = state.players.get(seat)?.manaPool;
    players[playerRole] = { name: playerRole === 'me' ? me : opponent,
      life: state.players.get(seat)?.lifeTotal ?? null,
      hand: playerRole === 'me' ? zoneCards('Hand').filter(c => c.visibility !== 'hidden') : [],
      handSize: zoneFor('Hand')?.objectInstanceIds?.length ?? null,
      librarySize: zoneFor('Library')?.objectInstanceIds?.length ?? null,
      mana_pool: Array.isArray(observedMana) ? observedMana.map(mana => ({
        color: typeof mana.color === 'string' ? mana.color.replace('ManaColor_', '') : null,
        amount: typeof mana.count === 'number' ? mana.count : null,
        source_instance_id: state.card(mana.srcInstanceId, names) ? mana.srcInstanceId : null,
      })) : null,
      mana_pool_source: Array.isArray(observedMana) ? 'last_observed' : 'unknown',
      battlefield, graveyard: zoneCards('Graveyard'), exile: zoneCards('Exile') };
  }
  const stack = [...state.zones.values()].filter(zone => zone.type === 'ZoneType_Stack')
    .flatMap(zone => zone.objectInstanceIds ?? []).map(card).filter(Boolean);
  return { turn: state.turn.turnNumber ?? 0, phase: state.turn.phase ?? null, step: state.turn.step || null,
    activePlayer: role(state.turn.activePlayer), priorityPlayer: role(state.turn.priorityPlayer),
    gameStateId, players, stack, warnings: ['Priority is the last observed GRE value; unrecorded priority windows are unknown.'] };
}

export function visibleStateSignature(snapshot) {
  const { priorityPlayer, gameStateId, warnings, ...meaningful } = snapshot;
  return JSON.stringify(meaningful);
}
