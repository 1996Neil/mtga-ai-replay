// Adapted from the upstream hover store; previews always belong to the current frame.
import { create } from 'zustand';
import type { CardInstance } from '../types/game';

const sameCard = (a: CardInstance | null, b: CardInstance | null) =>
  Boolean(a && b && a.instanceId === b.instanceId && a.grpId === b.grpId);

interface HoverState {
  card: CardInstance | null;
  pinned: boolean;
  preview: (card: CardInstance) => void;
  clearPreview: (card?: CardInstance) => void;
  togglePinned: (card: CardInstance) => void;
  close: () => void;
  /** Existing frame navigation calls setHovered(null) to clear even a pinned card. */
  setHovered: (card: CardInstance | null) => void;
}

export const useHoverStore = create<HoverState>(set => ({
  card: null,
  pinned: false,
  preview: card => set(state => state.pinned ? {} : { card }),
  clearPreview: card => set(state => !state.pinned && (!card || sameCard(card, state.card)) ? { card: null } : {}),
  togglePinned: card => set(state => state.pinned && sameCard(card, state.card)
    ? { card: null, pinned: false } : { card, pinned: true }),
  close: () => set({ card: null, pinned: false }),
  setHovered: card => set(state => card === null ? { card: null, pinned: false } : state.pinned ? {} : { card }),
}));
