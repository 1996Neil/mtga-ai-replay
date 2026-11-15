import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);

test('cloud review and UI integration preserves the App entry points', async () => {
  const app = await readFile(new URL('viewer/src/App.tsx', root), 'utf8');
  for (const pattern of [/<ReplayReviewCoach\b/, /onJump\s*=/, /\bintegrityMessages\b/, /advanced-tools/, /id="replay-controls"/]) {
    assert.ok(pattern.test(app), `Required App entry point missing: ${pattern}`);
  }
  assert.ok(!/<NearbyActions\b/.test(app), 'NearbyActions must not render in App');
});

test('default Viewer test retains full coverage', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.ok(pkg.scripts['viewer:test'].split(/\s+/).includes('--full-viewer'));
});

test('restricted Viewer declaration and all 19 source pins are preserved', async () => {
  const manifest = JSON.parse(await readFile(new URL('docs/restricted-viewer.json', root), 'utf8'));
  assert.equal(manifest.private_repository_inclusion, 'User-authorized for private PR #3 review on 2026-10-14 only; this does not grant or claim upstream redistribution rights.');
  assert.equal(manifest.files.length, 19);
  for (const entry of manifest.files) {
    const bytes = await readFile(new URL(entry.path, root));
    assert.ok(createHash('sha256').update(bytes).digest('hex') === entry.sha256, `Viewer pin mismatch: ${entry.path}`);
  }
});
