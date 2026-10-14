// The upstream card cache/store boundary is kept; persistent image caching belongs to the local API.
import { create } from 'zustand';
export interface CardMetadata { arena_id: number; name?: string; display_name_zh?: string; mana_cost?: string; type_line?: string; power?: string; toughness?: string; source?: string; }
export const useCardCacheStore = create<{ cards: Map<number, CardMetadata>; put: (id: number, card: CardMetadata) => void }>(set => ({
  cards: new Map(), put: (id, card) => set(state => ({ cards: new Map(state.cards).set(id, card) })),
}));
