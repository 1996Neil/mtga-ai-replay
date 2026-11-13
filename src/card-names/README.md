# Bundled card names

`cards.jsonl.gz` + `manifest.json` are a pinned names-only copy of:

- https://github.com/1996Neil/mtga-card-names
- release `data-2026.65.0-r1`
- schema `MTGA_CARD_NAMES_V1`

Replay2 uses this bundle so Chinese display names work even when MTGA has no
Chinese localization installed. If an installed game database has names for the
same `GrpId`, those strings win; the bundle fills the rest.

Update / build-time fetch:

```bash
npm run names:check     # verify the committed cache against the pin
npm run names:sync      # download the pinned release and replace the cache
npm run build:prepare   # names:sync + bundle contract test
```

`names:sync` writes `src/card-names/cards.jsonl.gz` and `manifest.json` in the
checkout. Run it before packaging so the built artifact contains the pinned data;
commit the result if the source tree is the release artifact.

Offline update (already-downloaded release assets):

```bash
node tools/sync-card-names.mjs \
  --input /path/to/cards.jsonl.gz \
  --manifest /path/to/manifest.json --apply
```

`RELEASE.json` is the pin; the sync tool verifies manifest and gzip hashes before
writing. Do not hand-edit `cards.jsonl.gz` or `manifest.json`.

The data is third-party fan content, not MIT-licensed Replay2 code. See the
upstream `DATA-NOTICE.md`; do not redistribute rules text or game files.
