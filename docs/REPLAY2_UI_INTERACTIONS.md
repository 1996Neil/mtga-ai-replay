# Replay UI interaction integration

This change carries the locally accepted UI candidate into source `main`, on top
of its existing P1 layout and cloud review integration. It does not deploy or
replace an installed Replay service. Existing cloud-review controls, synchronization,
collection, timeline, model policy and data locations remain in their original paths.

## Shared behavior

| Interaction | Common implementation | Boundary checks |
| --- | --- | --- |
| Light fan hand | `HandZone` and `lightHandFan` | 0/1/3/7/12/16/40 cards; scrolling and keyboard selection retain all cards |
| Hover/focus combat | `CardImage`, `combatFocusStore`, `combatFocus` | Direct one-to-many and many-to-many edges; no new game targets |
| Click card art | One `CardInspectorOverlay` native modal | Battlefield, hand, graveyard, exile, attachment and captive views share the same click path; click anywhere or Escape closes the art |
| Attack/block lines | `RelationshipArrows`, `relationshipGeometry` | Facing-edge midpoint for either seat, tapped art and planeswalker targets; original S curves, long combat handles capped at 180px; colors unchanged |
| Duplicate targets | `withoutCombatDuplicates` | Suppress ordinary duplicate attack-target lines for every event type; independent spell chains survive |
| Combat labels | Shared permanent CSS | Four-pixel gap above visible upright/tapped faces; no constant combat selection box |
| Land piles | Existing `landPiles` and `LandStack` | Exact instances retained; attached/captive lands render separately; expansion remains available |
| Attachments | `attachmentLayout` | Explicit observed hosts, cross-controller hosts, chains, broken links and cycles retain all instances |
| Other permanents | `battlefieldSections` | Creatures in main rows, ordinary noncreatures to the side, planeswalkers/Sagas/Battles in their own side lane; observed types outrank printed types |
| Captive cards | `exile-links`, `linkedExileGroups` | Observed GRE cause only; 62% thumbnail below source; original exile object retained; no card-name inference |
| Opponent hand | `hand-knowledge`, explicit adapter projection | Only observed identities continuously present in hand remain viewable; hidden new draws stay hidden; no historical-card UI |
| Match menu | Shared picker ref and outside click listener | Outside click and selection close the outer menu |

There are no real match IDs, anchor-specific fixes or named-card branches in the
interaction implementation. Layout-lab fixtures are synthetic verification data,
not production conditions.

## Information and compatibility

The original opponent `hand` export remains empty. `revealed_hand` is a dedicated
viewer projection; `hand_history` is not displayed. Both fields and `exiled_by`
are filtered from Coach context. The corrected public shared-exile membership is
an explicit input change: its already visible exile facts may appear in existing
Coach context. No hidden identity is inferred from a raw Arena ID or future frame.

Old archives without these projection fields do not gain hand knowledge or
captivity links merely by upgrading the Viewer. They need their original logs
reprojected by the normal pipeline. No automatic bulk migration or production
archive replacement is included.

## Validation and limits

Run `npm test`, `npm run viewer:test`, `npm run viewer:build` and
`npm run check:release` on this source repository. The original local candidate's
381-test backend run had 372 passes and 9 pre-existing failures; that is separate
from this repository's portable suite, which explicitly skips locked private-corpus
checks. Do not relabel skipped private data as passing coverage.

The source integration retains `ReplayReviewCoach` from main. Local full-application
interaction review uses isolated recorded data and blocked external writes. It does
not constitute real upload, collection write, paid model or speech acceptance.

Known limits: arrow routing does not avoid every intervening card; narrow windows
can require region scrolling or collapsing the stack; unknown Battle protectors and
special player attachments are not guessed. Card-image black margins belonging to
the original asset remain intact. Public redistribution rights are not asserted.

Rollback before deployment is a normal revert of the UI integration commit; there
is no data migration to undo. No unmerged P2 memory or P3 branch is included.
