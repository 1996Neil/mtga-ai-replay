import type { Relationship } from './relationships.ts';
import type { CombatLink } from './combatPresentation.ts';

/** Combat already shows this observed source/target pair. Avoid drawing a
 * second yellow event line on top of it (damage/target/trigger included).
 * Compare the unfiltered combat graph, so focus and blocked attackers cannot
 * bring a suppressed duplicate back. Independent stack chains stay intact. */
export function withoutCombatDuplicates(ordinary: readonly Relationship[], combat: readonly CombatLink[]): Relationship[] {
  const pairs = new Set(combat.filter(link => link.kind === 'attack').map(link => JSON.stringify([link.from, link.to])));
  return ordinary.filter(link => link.kind !== 'target' || !pairs.has(JSON.stringify([link.from, link.to])));
}
