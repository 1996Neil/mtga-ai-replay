import type { CardInstance } from '../types/game.ts';

export type BattlefieldSection = 'main' | 'land' | 'featured' | 'side';
/** Current observed types outrank printed metadata. The optional type line only
 * supplies a missing Saga subtype, never changes a recorded creature/land type. */
export function battlefieldSection(card: CardInstance, fallbackTypeLine?: string): BattlefieldSection {
  const types = card.cardTypes;
  if (types.includes('CardType_Creature')) return 'main';
  const saga = types.includes('CardType_Saga') || (types.includes('CardType_Enchantment') && /\bSaga\b/.test(card.typeLine ?? fallbackTypeLine ?? ''));
  if (saga || types.includes('CardType_Planeswalker') || types.includes('CardType_Battle')) return 'featured';
  if (types.includes('CardType_Land')) return 'land';
  if (types.includes('CardType_Artifact') || types.includes('CardType_Enchantment')) return 'side';
  return 'main'; // Missing type information must not be guessed from a card name.
}

/** Attached cards are grouped under their host before applying these sections. */
export function battlefieldSections(cards: readonly CardInstance[], typeLine?: (card: CardInstance) => string | undefined) {
  const result: Record<BattlefieldSection, CardInstance[]> = { main:[], land:[], featured:[], side:[] };
  for (const card of cards) result[battlefieldSection(card,typeLine?.(card))].push(card);
  return result;
}
