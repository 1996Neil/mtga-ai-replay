# Replay exclusions

Explicit Arena tutorial modes (`NPE_Tutorial_*` and `Tutorial_*`) are omitted by
the parser and archive. Coach bundle generation and upload queue publication
reject them as well. Ordinary starter-deck events, Jump In, ranked play, and
drafts remain eligible.

Explicit local deletion through `excludeArchivedReplays` removes the replay and
its local coaching notes in one transaction and persists an ID tombstone.
Retained game logs cannot import that match again; stale queued bundles cannot
upload it. This is an exact match-ID exclusion, not a nickname blacklist.

Existing published files require an explicit removal commit. Such a commit
removes the current data and index entries without rewriting Git history.
