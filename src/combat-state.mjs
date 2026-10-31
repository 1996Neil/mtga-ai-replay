/** The canonical combat contract preserves choices separately from committed combat. */
export function projectCombatState(object) {
  const attack = object.attackState ?? 'AttackState_None';
  const block = object.blockState ?? 'BlockState_None';
  return {
    attack_state: attack, block_state: block,
    is_attacking: ['AttackState_Declared', 'AttackState_Attacking'].includes(attack),
    attacking_target_id: object.attackInfo?.targetId ?? null,
    is_blocking: (object.blockInfo?.attackerIds?.length ?? 0) > 0,
    blocked_attacker_ids: [...(object.blockInfo?.attackerIds ?? [])],
    is_blocked: block === 'BlockState_Blocked',
  };
}

/** Older snapshots retain their observed flags; absence never proves unblocked. */
export function normalizeCombatState(raw) {
  return {
    attackState: raw.attack_state ?? raw.attackState,
    blockState: raw.block_state ?? raw.blockState,
    isAttacking: Boolean(raw.is_attacking ?? raw.isAttacking),
    attackingTargetId: raw.attacking_target_id ?? raw.attackingTargetId,
    isBlocking: Boolean(raw.is_blocking ?? raw.isBlocking ?? raw.blocked_attacker_ids?.length),
    blockedAttackerIds: raw.blocked_attacker_ids ?? raw.blockedAttackerIds ?? [],
    isBlocked: Boolean(raw.is_blocked ?? raw.isBlocked ?? (raw.block_state ?? raw.blockState) === 'BlockState_Blocked'),
  };
}
