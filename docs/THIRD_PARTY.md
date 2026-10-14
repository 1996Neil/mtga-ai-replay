# Source and license record

The repository is private development source. No blanket MIT license is asserted.
Owned code has no new public license granted by this export.

- `mtga-log-parser@4.1.0`: unmodified npm dependency, MIT, copyright 2026
  kristeehan. Actual notice retained in LICENSE.mtga-log-parser; package integrity
  remains pinned in the root lockfile. It has no third-party runtime dependencies.
- Viewer npm packages: React/React DOM 19.2.6, Zustand 5.0.13, Vite 8.3.2,
  React Vite plugin 6.0.2, Tailwind 4.3.0 and React type definitions are MIT;
  TypeScript 6.0.3 is Apache-2.0. Actual package notices accompany installed
  dependencies; exact versions/integrities are unchanged in viewer/package-lock.json.
- Optional `mtga-reader@0.1.13`: unmodified GPL-3.0-only package, separately
  locked in tools/collection-reader. The complete GPL notice is retained as
  LICENSE.mtga-reader. No package source or native binary is vendored; root
  installation does not install it. Its Mac memory helper is not executed in
  cloud development or any export validation.
- `m1kk3l/mtg-replay-viewer`, revision
  `472969b805c1e62e17797c7cdac7f69f3670597c`: no declared code license at the
  inspected revision. Existing attribution is preserved in viewer/ATTRIBUTION.md.
  18 directly copied/adapted source files plus index.css are included in private
  PR #3 under explicit user authorization for review dated 2026-10-14. The
  CardPreviewPane symbol is part of CardImage.tsx, not a separate file. Exact
  hashes and paths are in restricted-viewer.json, and attribution remains in
  viewer/ATTRIBUTION.md. This does not establish an upstream license or authorize
  public redistribution; no compiled Viewer output or upstream artwork is included.

No Arena artwork, Scryfall images, card database/collection cache or launcher icon
is bundled. Small public card-rule text is used only in deidentified regression
windows; it is not a redistributed complete card dataset.

GitHub's license explanation states that absence of a license leaves copyright
rights reserved: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository
Private visibility does not resolve the missing upstream permission.
