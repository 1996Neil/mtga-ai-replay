import type { CardInstance } from '../types/game';

// Resolve only in the note's actual boundary. Never borrow a future printing or
// fuzzy-match an English machine identity to obtain a translated display name.
export function reviewCardId(name: string, objects?: Map<number, CardInstance>): number {
  const ids = new Set([...objects?.values() ?? []]
    .filter(card => card.name === name && ['player_known', 'public', 'visible'].includes(card.visibility ?? '') && Number.isSafeInteger(card.grpId) && card.grpId > 0)
    .map(card => card.grpId));
  return ids.size === 1 ? [...ids][0] : 0;
}

export function reviewCardTranslation(english: string, metadataName?: string, chinese?: string): string | null {
  return metadataName === english && chinese?.trim() && chinese.trim() !== english ? chinese.trim() : null;
}
