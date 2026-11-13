# Bundled card names

`cards.jsonl.gz` + `manifest.json` are a pinned names-only copy of:

- https://github.com/1996Neil/mtga-card-names
- release `data-2026.64.50-r5`
- schema `MTGA_CARD_NAMES_V1`

Replay2 uses this bundle so Chinese display names work even when MTGA has no
Chinese localization installed. If an installed game database has names for the
same `GrpId`, those strings win; the bundle fills the rest.

Update:

```bash
node tools/sync-card-names.mjs --check
node tools/sync-card-names.mjs --apply
```

`RELEASE.json` is the pin; the sync tool verifies manifest and gzip hashes before
writing. Do not hand-edit `cards.jsonl.gz` or `manifest.json`.

The data is third-party fan content, not MIT-licensed Replay2 code. See the
upstream `DATA-NOTICE.md`; do not redistribute rules text or game files.
