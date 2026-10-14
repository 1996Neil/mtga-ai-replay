# Viewer source attribution

This is a private local adaptation of [m1kk3l/mtg-replay-viewer](https://github.com/m1kk3l/mtg-replay-viewer), inspected at commit [`472969b805c1e62e17797c7cdac7f69f3670597c`](https://github.com/m1kk3l/mtg-replay-viewer/tree/472969b805c1e62e17797c7cdac7f69f3670597c).

No code license was declared in that repository at inspection. The user explicitly authorized useful local source copying with clear attribution for this private tool. This file records that provenance; it does not claim the upstream code is MIT licensed. The user authorized these 19 existing adapted files to be included in private repository PR #3 for review on 2026-10-14. That authorization does not establish an upstream license or public redistribution rights.

## Reused and adapted source

These original files were copied into the same paths under `viewer/src/`, then adapted to consume canonical, chronologically filtered snapshots:

- `components/GameBoard.tsx`: two player fields, inline graveyards, own hand, inspector/stack column. Added exile, phase/priority and combat relationships; removed the fixed 1920×1080 scaled stage.
- `components/BattlefieldZone.tsx`: player-relative land/creature/other row ordering and ResizeObserver sizing. Added per-row sizing, P/T, tap/attack/block/token/counter/attachment labels and current-event highlight.
- `components/HandZone.tsx`: separate face-up and face-down rendering. Opponent cards are always count/backs only; own cards use the exact selected snapshot.
- `components/GraveyardZone.tsx`: top-card pile and full-zone popup. Also used for public exile; native dialog provides Escape and keyboard focus behavior.
- `components/StackZone.tsx`: reverse-order stack rendering and top marker. Added known target names and ability labels.
- `components/PlayerInfo.tsx`: active-player/priority/life/hand/library information bar; retained the layout with explicit text labels.
- `components/ReplayControls.tsx`, `components/TurnSlider.tsx`, `components/PhaseIndicator.tsx`: play/pause, 0.5×/1×/2×/4×, first/last/action navigation, slider ticks and phase presentation. Added actual previous/next turn controls and accessible labels.
- `store/replayStore.ts`: Zustand selection/current-step/playback architecture, bounded action navigation and speed state. Added anchor navigation, turn navigation and before/after Arena frame selection.
- `hooks/useReplayEngine.ts`: timed automatic playback and stopping at the final step.
- `hooks/useElementSize.ts`: ResizeObserver hook, directly reused without modification.
- `types/game.ts`: CardInstance, PlayerState, GameState, ReplayStep and ParsedMatch renderer model; extended with canonical anchor/combat/target/coach fields.

These files were adapted from the inspected source design and implementation with a replaced data/network boundary:

- `components/CardImage.tsx` and `CardPreviewPane`: card art, P/T/text fallback, tapped rendering and selected-card preview. Image/metadata requests go only to the local server; persistent image caching is server-owned.
- `hooks/useCardImage.ts`, `store/cardCacheStore.ts`, `store/hoverStore.ts`: current-visible-card image/metadata and selection boundaries. Removed direct browser Scryfall/IndexedDB access.
- `components/GameLog.tsx`: turn-grouped, automatically scrolling timeline. Its annotation reconstruction was replaced with canonical event descriptions and clickable stable anchors.
- Dark slate zone borders and replay-control palette from the upstream Tailwind components are retained.

## New local integration

`App.tsx`, `lib/canonicalAdapter.ts`, pooled-state resolution, match history API loading, URL anchors, shared-frame warnings and local Coach Context download are new integration code. The adapter is a renderer-model adapter, not another MTGA log parser.

The upstream `lib/logParser.ts`, log parser worker, file upload flow, card-map data and browser Scryfall fetchers are **not copied or used**. Player.log parsing remains exclusively in the existing `mtga-gpt-replay` pipeline.

## Third-party packages

Runtime: React 19.2.6 and React DOM 19.2.6 (MIT), Zustand 5.0.13 (MIT). Build: Vite 8.3.2 (MIT), React Vite plugin 6.0.2 (MIT), Tailwind CSS and its Vite plugin 4.3.0 (MIT), TypeScript 6.0.3 (Apache-2.0), React type declarations 19.2.14 / React DOM types 19.2.3 (MIT). Exact versions and transitive packages are pinned in `viewer/package-lock.json`; their package license files remain in installed packages. Vite was updated from the upstream 8.0.13 to resolve its known development-server advisories; the user's replay command serves production static assets with the project's loopback server.

2026-10-02 UI adaptation: on-demand history/analysis, fixed-width cards and land piles, combat pairing, local Chinese display labels, floating pinned inspector, Chinese transport/timeline. The upstream parser/model boundaries remain unchanged.
