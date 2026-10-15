# Replay integration ledger

## Verified online source baseline

Baseline main: `350b6fb41e9b0bb5e5998f4dbc9ad7ec521841de`.
The cloud workspace was checked against every blob in that exact GitHub tree before changes.

All 14 repository PRs were checked against this baseline by commit ancestry:

- #1, #2, #3, #4, #6, #7, #8, #11, #12, #14, #17 and #18 heads are ancestors of main.
- #15 was squash merged as `89d7899352f6b885ab652d8a85fe1b98ff7790a3`. Its head and squash commit have the same tree `ec4fc8a7e7f4b61e9aa269d5bdb819603b1001c8`; its original head not being an ancestor is not a missing feature.
- #9 head `481846cc9ccb32a1ecc73e55c5e9d64ad09bce0b` was not integrated. Main lacked `src/draft-runs.mjs`, the draft-run HTTP route and the grouped history UI. Some types/CSS and match-seat fixes existed independently; these did not make the feature complete.

## This integration

Integrate #9 against current main, preserving both parent histories. Restore per-course draft groups, wins/losses, expandable match members, dates, land-based colors, and the existing #9 sidecar/import contracts. This restores previously implemented functionality; it does not implement a new phase-two AI draft analysis system.

Conflict resolutions preserve:

- P2 hand, combat, permanent and native card inspector behavior.
- The history menu's outer ref, outside-click closing and selection closing even inside nested draft groups.
- P3 immutable archive protection and published-history identity/readonly labels.
- PR18 card identity checking, image retry behavior and bounded network work.
- Existing private-inclusion declarations, with only resulting file hash pins updated.

Draft history refresh is isolated from ordinary match loading. A failed or slow sidecar request cannot block opening a normal replay. Stale draft data is explicitly marked, requests are bounded and cancelled on unmount. Published-history sessions do not read local draft sidecars.

## Integration-specific regression

The first full run found an old #9 test that expected a known deck card to be overwritten. P3 correctly rejected that overwrite. Production archive protections were not weakened. The test now explicitly checks that the conflicting deck remains unchanged, and separately checks projection-cache refresh after an allowed richer archive with preserved card identity.

New checks exercise two distinct draft courses through the real HTTP route, preserve their 1-1 and 1-0 records and all match members, ensure published-history refuses even to open a corrupt local draft database, and check the combined UI entry points.

## Validation boundaries

Synthetic tests and a production build are not desktop UI acceptance, real-upload performance measurements or proof of AI advice quality. This integration does not write real matches, notes, credentials or the user's Mac. Desktop installation and launcher switching remain separate and unverified here. Other unsubmitted/local candidates are not covered by the online PR ledger.
