// Adapted from m1kk3l/mtg-replay-viewer (see viewer/ATTRIBUTION.md).
import { create } from 'zustand';
import type { ParsedMatch, ReplayStep } from '../types/game';

interface ReplayState {
  matches: ParsedMatch[]; currentMatchIndex: number; currentStepIndex: number;
  isPlaying: boolean; playbackSpeed: number; viewBefore: boolean;
  setMatches: (matches: ParsedMatch[]) => void; refreshMatches: (matches: ParsedMatch[]) => boolean; selectMatch: (index: number) => void;
  goToStep: (index: number) => void; goToAnchor: (anchor: string) => boolean;
  stepForward: () => void; stepBackward: () => void;
  previousTurn: () => void; nextTurn: () => void; goToFirst: () => void; goToLast: () => void;
  togglePlay: () => void; pause: () => void; setSpeed: (speed: number) => void;
  setViewBefore: (before: boolean) => void;
  currentMatch: () => ParsedMatch | null; currentStep: () => ReplayStep | null;
}

export const useReplayStore = create<ReplayState>((set, get) => ({
  matches: [], currentMatchIndex: 0, currentStepIndex: 0, isPlaying: false, playbackSpeed: 1, viewBefore: false,
  setMatches: matches => set({ matches, currentMatchIndex: 0, currentStepIndex: 0, isPlaying: false, viewBefore: false }),
  refreshMatches: matches => {
    const current = get().currentMatch(), step = get().currentStep();
    if (!current) return false;
    const index = matches.findIndex(game => game.matchId === current.matchId && game.gameNumber === current.gameNumber);
    if (index < 0) return false;
    const at = step ? matches[index].steps.findIndex(value => value.anchor === step.anchor) : 0;
    if (at < 0) return false; // A removed anchor needs an explicit navigation.
    set({ matches, currentMatchIndex: index, currentStepIndex: at });
    return true;
  },
  selectMatch: index => set({ currentMatchIndex: index, currentStepIndex: 0, isPlaying: false, viewBefore: false }),
  goToStep: index => {
    const match = get().currentMatch();
    if (match) set({ currentStepIndex: Math.max(0, Math.min(index, match.steps.length - 1)) });
  },
  goToAnchor: anchor => {
    const { matches, currentMatchIndex } = get();
    const order = [currentMatchIndex, ...matches.map((_, i) => i).filter(i => i !== currentMatchIndex)];
    for (const i of order) {
      const at = matches[i].steps.findIndex(s => s.anchor.toLowerCase() === anchor.trim().toLowerCase());
      if (at >= 0) { set({ currentMatchIndex: i, currentStepIndex: at, isPlaying: false }); return true; }
    }
    return false;
  },
  stepForward: () => {
    const { currentStepIndex, currentMatch } = get();
    const match = currentMatch();
    if (match && currentStepIndex < match.steps.length - 1) set({ currentStepIndex: currentStepIndex + 1 });
    else set({ isPlaying: false });
  },
  stepBackward: () => { const i = get().currentStepIndex; if (i > 0) set({ currentStepIndex: i - 1 }); },
  previousTurn: () => {
    const { currentStepIndex } = get(), steps = get().currentMatch()?.steps ?? [];
    const turn = steps[currentStepIndex]?.turnNumber;
    const earlier = steps.slice(0, currentStepIndex).filter(s => s.turnNumber !== turn).at(-1);
    get().goToStep(earlier ? steps.findIndex(s => s.turnNumber === earlier.turnNumber) : 0);
  },
  nextTurn: () => {
    const { currentStepIndex } = get(), steps = get().currentMatch()?.steps ?? [];
    const turn = steps[currentStepIndex]?.turnNumber;
    const at = steps.findIndex((s, i) => i > currentStepIndex && s.turnNumber !== turn);
    get().goToStep(at >= 0 ? at : steps.length - 1);
  },
  goToFirst: () => set({ currentStepIndex: 0, isPlaying: false }),
  goToLast: () => { const match = get().currentMatch(); if (match) set({ currentStepIndex: Math.max(0, match.steps.length - 1), isPlaying: false }); },
  togglePlay: () => {
    const s = get(), last = (s.currentMatch()?.steps.length ?? 0) - 1;
    set({ isPlaying: !s.isPlaying, currentStepIndex: !s.isPlaying && s.currentStepIndex === last ? 0 : s.currentStepIndex });
  },
  pause: () => set({ isPlaying: false }), setSpeed: playbackSpeed => set({ playbackSpeed }),
  setViewBefore: viewBefore => set({ viewBefore }),
  currentMatch: () => get().matches[get().currentMatchIndex] ?? null,
  currentStep: () => get().currentMatch()?.steps[get().currentStepIndex] ?? null,
}));
