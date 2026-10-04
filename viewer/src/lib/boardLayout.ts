import type { CardInstance } from '../types/game';
/** Presentation groups only. Individual instances and observed state stay intact. */
export function landPiles(cards: CardInstance[]): CardInstance[][] {
  const groups = new Map<string, CardInstance[]>();
  for (const card of cards) {
    const key = `${card.name || card.grpId}:${card.isTapped}`;
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  return [...groups.values()];
}
export function permanentGroups(cards: CardInstance[]): CardInstance[][] {
  const groups = new Map<string, CardInstance[]>();
  for (const card of cards) {
    const key = JSON.stringify([card.grpId, card.isTapped, card.power, card.toughness,
      Object.entries(card.counters).sort(), card.attachedTo, card.attachments,
      card.isAttacking, card.isBlocking, card.blockedAttackerIds, card.damage,
      card.objectType, card.ownerSeatId, card.controllerSeatId, card.visibility]);
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  return [...groups.values()];
}
export function combatGroups(cards: CardInstance[]) {
  return cards.filter(c => c.isAttacking).map(attacker => ({ attacker,
    blockers: cards.filter(c => c.isBlocking && c.blockedAttackerIds?.includes(attacker.instanceId)),
  }));
}
