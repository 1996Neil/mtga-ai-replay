# Replay cloud and UI integration — 2026-10-15

This isolated integration preserves two fixed parents in order:

1. PR #7, cloud review: `bf70d7934e9aa5d3b9c06f93b41b335f0697525b`.
2. PR #8, UI: `2f9b3b144552fb191d9e629dc95f03f03a705dda`.

Relative to PR #7, `App.tsx` only removes the `NearbyActions` import and render.
Cloud review, synchronization, integrity messages, advanced tools, and replay
controls remain connected. Integration tests guard these connections, the full
Viewer test command, and the restricted-source declaration and hashes.

Eight manifest-pinned Viewer sources come from PR #8: `GameBoard.tsx`,
`BattlefieldZone.tsx`, `HandZone.tsx`, `StackZone.tsx`, `ReplayControls.tsx`,
`GameLog.tsx`, `types/game.ts`, and `index.css`. The first six are under
`viewer/src/components/`; the last two are under `viewer/src/`. The sole
normalization to those imported sources removes two trailing spaces on line 2
of `index.css`; its manifest hash is updated accordingly. The other eleven
restricted sources retain PR #7 content. The existing private-inclusion
declaration remains unchanged and grants no public redistribution rights.

The portable test runner from PR #8 is retained, while both default and full
Viewer commands explicitly select `--full-viewer`. The stack component test
uses Vite `configLoader: 'runner'` to avoid temporary configuration writes into
shared dependencies; its assertions are unchanged.

Validation on the frozen integration source:

- Backend: 417 tests, 409 PASS, 8 SKIP, zero failures or cancellations. The
  skipped cases require the intentionally excluded private corpus.
- Viewer: 97 PASS, zero failures or skips.
- Viewer TypeScript/Vite build, release-policy scan, and whitespace checks pass.
- Synthetic browser checks pass at 1440×900 and 390×844: AI entry and two
  markers, jumps to `T5-A1:before` and `T5-A3:after`, close/reopen, simulated
  synchronization changing the review to stale and clearing both markers,
  floating panel within the viewport, and no captured JavaScript errors.
- Temporary synthetic entry pages were removed after verification. Screenshots,
  raw logs, build output, and dependencies are excluded from this commit.

The browser checks use synthetic data and intercepted responses. Real cloud
synchronization, model quality, and memory risks have not been reaccepted in
this integration. PR #9 and Issue #10 work are excluded. This candidate has not
been deployed; the formal running service remains unchanged.
