import type { CardInstance } from '../types/game';

/** Defense in depth: anonymous/hidden cards cannot enter the image or name resolver. */
export function visibleCardId(grpId: number, card?: Pick<CardInstance, 'visibility'>): number {
  return /hidden|post.?game/i.test(card?.visibility ?? '') || !Number.isFinite(grpId) || grpId <= 0 ? 0 : grpId;
}

/** Local metadata can contain the last observed dynamic stats, which belong to a later frame. */
export function printedCardStats(metadata?: { source?: string; power?: string; toughness?: string }) {
  return metadata?.source === 'scryfall'
    ? { power: metadata.power, toughness: metadata.toughness }
    : { power: undefined, toughness: undefined };
}

/** Readability stays fixed; additional cards overlap or scroll instead of becoming smaller. */
export function handFanLayout(count: number, availableWidth: number) {
  const cardWidth = 128;
  const usableWidth = Math.max(cardWidth, availableWidth - 32);
  const stride = count <= 1 ? cardWidth : Math.min(cardWidth + 14, Math.max(28, (usableWidth - cardWidth) / (count - 1)));
  return { cardWidth, stride, width: count ? cardWidth + (count - 1) * stride : 0 };
}
