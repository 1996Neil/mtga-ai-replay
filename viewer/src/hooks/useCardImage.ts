// Browser reads only our same-origin local API.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useCardCacheStore } from '../store/cardCacheStore';
import { printedCardStats } from '../lib/cardPresentation';
import { createCardImageClient } from '../lib/cardImageClient';
const client = createCardImageClient({ onCard: (id, card) => useCardCacheStore.getState().put(id, card) });
export function useCardImage(grpId: number) {
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const changed = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  const visibleId = pageVisible && Number.isSafeInteger(grpId) && grpId > 0 ? grpId : 0;
  const subscribe = useCallback((fn: () => void) => client.subscribe(visibleId, fn), [visibleId]);
  const snapshot = useCallback(() => client.snapshot(visibleId), [visibleId]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const card = useCardCacheStore(s => s.cards.get(visibleId));
  return { imageUrl: visibleId && state.phase === 'ready' ? `/api/cards/${visibleId}/image${state.refreshImage ? '?retry=1' : ''}` : null,
    imageAttempt: state.attempt, imagePhase: state.phase,
    retryImage: () => client.retry(visibleId),
    imageError: () => client.imageError(visibleId, state.attempt),
    imageLoaded: () => client.imageLoaded(visibleId, state.attempt),
    name: card?.name, displayNameZh: card?.display_name_zh,
    typeLine: card?.type_line, manaCost: card?.mana_cost, ...printedCardStats(card) };
}
