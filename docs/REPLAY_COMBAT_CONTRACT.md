# Combat replay observations

Schema 2.1 preserves `attack_state`, `block_state` and `is_blocked` alongside
existing combat flags. `Declared` means a tentative selection; `Attacking` and
`Blocking` mean committed combat. Tentative and cancelled selections remain in
chronological state observations for live-state consumers, but are not emitted
as replay actions. The timeline contains only committed attacks, committed
blocks and actual results. A blocked attacker remains blocked until the
recorded end of combat, including after every blocker leaves.

The Viewer reads canonical `damage_marked` (and legacy `damage`) and carries
`logical_id` on visible event participants across observed object-ID changes.
An absent endpoint is never replaced with a guessed player or another card.
Hidden and postgame identities cannot be recovered through these links.

One GRE message can report damage, deaths and life changes together. Its events
share the same before/after observations. Playback advances once per observation;
individual event anchors and comments remain reachable in the timeline. The
same-resolution disclosure lists all effects and offers before/after controls.
It does not invent intermediate boards or show after-effects in the before view.

Attack arrows represent current combat relations. Once blocked, an attacker
does not regain a speculative arrow to its defender. An explicitly recorded
trample damage event can still show a separate damage relationship.

## Explicit archived-match repair

Ordinary idle observation remains incremental and does not rebuild old matches.
After a parser correction, preview one retained match with:

```sh
node bin/mtga-replay-repair.mjs --match MATCH_ID
```

Add `--apply` to replace that match locally. The repair reads only that match and
shared connection context, preserves its account, result, observed coverage,
anchors for retained actions and inline comments, and creates a private
single-match backup
under the data directory's `backups/replay-repair/` folder. It replaces only the
exact archived revision inspected; a concurrent change aborts the replacement.
New events receive unused anchors, so numeric anchor suffixes need not follow
timeline order after a repair. Playback order and displayed action numbers do.
Separate saved coach notes remain in their existing table. No remote write runs.

The backup contains the prior replay and notes. Recovery can use `archiveReplays`
with the backed-up replay and the current exact `replaceRevision`; this retains
the same concurrency protection. Keep the backup until the repaired match has
been reviewed.

## Existing terminal snapshot without a timeline entry

For this narrow historical issue, append only the missing entry:

```sh
node bin/mtga-replay-terminal-repair.mjs --match MATCH_ID
```

`--apply` makes the change. Multiple explicit `--match` arguments run sequentially.
This path never rebuilds a game or loads rules/card dictionaries. It queries
GameOver evidence for the selected match through the ingest index, matches the
game number and saved state ID, and appends one step pointing to the first
proven terminal snapshot. Earlier actions, states, results and comments remain
unchanged. Missing evidence is never replaced by an inferred terminal state.
Each changed match receives a private backup in `backups/replay-terminal-repair/`
and the same strict revision check as a full repair. Global card metadata is
not scanned or rewritten by this repair. An unchanged retry performs
no archive write and creates no backup. No startup/polling or remote publication
calls this maintenance path.

New imports always retain an explicit GameOver step, including when lethal
damage or other final actions share that observation.

## Canceled tentative casts

A cast can be announced and then canceled before it is committed; Arena answers
with a full-state resync that restores the card's pre-cast object in its source
zone. That cast was never played, so it is not a replay action: the parser drops
the tentative action, and the frame that carried only it, when the resync proves
the rollback. The evidence is the archived snapshots themselves (spell on the
stack in one frame, back in the local hand with an empty stack in the next).

Archives written before this interpretation keep their old rows until an explicit
repair:

```sh
node bin/mtga-replay-cast-repair.mjs --match MATCH_ID          # preview
node bin/mtga-replay-cast-repair.mjs --match MATCH_ID --apply  # one match
```

The repair removes only the canceled cast rows and their events, keeps every
other anchor, state and comment, writes a private backup under the data
directory's `backups/replay-cast-repair/`, and refuses a changed archive
revision. Matches outside local retention are preserved by the archive policy.
No remote write runs; a later sync publishes the changed matches as updates.
