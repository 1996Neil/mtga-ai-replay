export interface CanonicalCombatState {
  attack_state: string;
  block_state: string;
  is_attacking: boolean;
  attacking_target_id: number | null;
  is_blocking: boolean;
  blocked_attacker_ids: number[];
  is_blocked: boolean;
}
export interface ViewerCombatState {
  attackState?: string;
  blockState?: string;
  isAttacking: boolean;
  attackingTargetId?: number;
  isBlocking: boolean;
  blockedAttackerIds: number[];
  isBlocked: boolean;
}
export function projectCombatState(object: Record<string, any>): CanonicalCombatState;
export function normalizeCombatState(raw: Record<string, any>): ViewerCombatState;
