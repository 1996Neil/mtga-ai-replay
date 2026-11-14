# Replay 2.0 P1 layout and stack release

This branch builds on the existing sync/collection PR branch. It does not merge the AI review, audit or cloud publication branches. The local accepted P1 layout had not been exported to this source repository; this PR therefore includes its owned UI dependencies plus the latest stack and combat-label correction.

The spell/ability stack uses a right-side rail with 156–192px faces, top-first recorded resolution, overlap, collapse and expansion. An empty details row no longer extends a card frame below its Chinese caption. Blocking labels reuse loaded localized metadata. Attack targets are retained only from explicit observations in the same causal combat window; hidden, changed or future observations are excluded. Canonical card names, identities, state and AI input are unchanged.

Fixed board geometry, land piles, player alignment and transport controls are the previously accepted P1 dependencies. No backend business logic, configuration, data migration or new dependency is included.

## Reproduction boundary

The repository retains its existing permission boundary. Restricted Viewer component source, patches and compiled artifacts are absent. Their SHA-256 pins point to the accepted local adaptation. The local source is not uploaded by this PR. After authorized local materialization, the full Viewer tests and TypeScript/Vite build can run. Cloud portable tests explicitly exclude the stack SSR test, which loads restricted components; all pure combat/history and layout tests remain enabled. This PR alone is not a self-contained cloud Viewer deployment.

Local accepted release: 9b850d9125af426e3da88ac7391202c24fb28865, following b15235b3fbe35e427ffe75cd7ccd79387dec790d. These identify local source snapshots only; their private history is not published. Full local Viewer suite: 86 passed. Four viewport and real replay checks cover stack resolution, card-frame bounds, Chinese blocking labels, causal attack targets, keyboard access, preview and unchanged board geometry. Existing backend baseline failures were not repaired or hidden by this UI change.
