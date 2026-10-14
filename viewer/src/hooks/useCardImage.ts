// Adapted from m1kk3l's useCardImage: browser reads only our same-origin local API.
import { useEffect } from 'react';
import { useCardCacheStore } from '../store/cardCacheStore';
import { printedCardStats } from '../lib/cardPresentation';
const requested = new Set<number>();
export function useCardImage(grpId: number) {
  const visibleId = Number.isFinite(grpId) && grpId > 0 ? grpId : 0;
  const card = useCardCacheStore(s => s.cards.get(visibleId));
  useEffect(() => {
    if (!visibleId || requested.has(visibleId)) return;
    requested.add(visibleId);
    fetch(`/api/cards/${visibleId}`).then(async r => {
      if (r.ok) useCardCacheStore.getState().put(visibleId, await r.json());
    }).catch(() => { /* text fallback remains usable offline */ });
  }, [visibleId]);
  const localized = card as (typeof card & { display_name_zh?: string });
  return { imageUrl: visibleId ? `/api/cards/${visibleId}/image` : null,
    name: card?.name, displayNameZh: localized?.display_name_zh,
    typeLine: card?.type_line, manaCost: card?.mana_cost,
    ...printedCardStats(card) };
}
