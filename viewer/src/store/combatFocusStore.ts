import { create } from 'zustand';

// Separate from card preview: hovering a relation never pins or opens a big card.
export const useCombatFocusStore = create<{
  instance: number | null; set: (instance: number | null) => void; clear: (instance?: number) => void;
}>(set => ({
  instance: null,
  set: instance => set({instance}),
  clear: instance => set(state => instance === undefined || instance === state.instance ? {instance:null} : {}),
}));
