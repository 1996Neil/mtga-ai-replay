import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { currentReviewSnapshot, reviewLaunchPresentation } from '../src/replay/reviewAvailability.ts';
import type { ReviewSnapshot, ReviewStatus } from '../src/replay/reviewAvailability.ts';

const steps = [{ anchor: 'T1-A1' }];
const match = { matchId: 'match-a', gameNumber: 1, steps };
const review = { match_id: 'match-a', game_number: 1, notes: [] as unknown[] };
const saved: ReviewSnapshot<typeof review> = { ...match, status: 'ready', review };
const present = (snapshot: ReviewSnapshot<typeof review>, current = match) => {
  const value = currentReviewSnapshot(snapshot, current);
  return { ...value, ...reviewLaunchPresentation(value.status, value.review?.notes.length ?? 0) };
};

test('only a validated current-game review is green, including a summary with no note markers', () => {
  const empty = present(saved);
  assert.equal(empty.tone, 'ready');
  assert.equal(empty.label, 'AI 复盘 · 0');
  assert.equal(empty.symbol, '✓');
  assert.equal(empty.description, '已有复盘记录，0 条建议');
  assert.equal(empty.busy, false);
  const withNotes = present({ ...saved, review: { ...review, notes: [{ anchor: 'T1-A1' }] } });
  assert.equal(withNotes.label, 'AI 复盘 · 1');
});

test('switching match, game, or replay revision hides old data before the next effect runs', () => {
  for (const current of [
    { ...match, matchId: 'match-b' }, { ...match, gameNumber: 2 }, { ...match, steps: [...steps] },
  ]) {
    for (const snapshot of [saved, { ...saved, status: 'missing' as const, review: null }]) {
      const result = present(snapshot, current);
      assert.equal(result.status, 'loading');
      assert.equal(result.review, null);
      assert.equal(result.tone, 'unknown');
      assert.equal(result.label, 'AI 复盘');
      assert.equal(result.busy, true);
    }
  }
});

test('a ready response with missing or mismatched identity cannot become green', () => {
  for (const wrong of [null, { ...review, match_id: 'match-b' }, { ...review, game_number: 2 }]) {
    const result = present({ ...saved, review: wrong });
    assert.equal(result.review, null);
    assert.equal(result.status, 'error');
    assert.equal(result.tone, 'unknown');
    assert.match(result.description, /状态未知/);
  }
});

test('missing and stale records are red while unresolved reads stay neutral', () => {
  for (const status of ['missing', 'stale', 'loading', 'syncing', 'error'] as ReviewStatus[]) {
    // Even an accidentally retained record must not make an unresolved status green.
    const result = present({ ...saved, status });
    assert.equal(result.review, null);
    assert.equal(result.tone, status === 'missing' || status === 'stale' ? 'missing' : 'unknown');
    assert.equal(result.busy, status === 'loading' || status === 'syncing');
    assert.notEqual(result.symbol, '✓');
    assert.ok(result.description);
  }
});

test('toolbar shares collection dimensions and keeps disclosure, keyboard, and text semantics', () => {
  const source = readFileSync(new URL('../src/components/ReplayReviewCoach.tsx', import.meta.url), 'utf8');
  const localTask = readFileSync(new URL('../src/components/LocalTaskButton.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/components/ReplayReviewCoach.css', import.meta.url), 'utf8');
  assert.match(localTask, /className="sync-button"/);
  assert.match(source, /className="sync-button replay-review-launch"/);
  assert.match(source, /aria-expanded=\{open\}/);
  assert.match(source, /aria-controls="replay-review-panel"/);
  assert.match(source, /aria-label=\{`AI 复盘，\$\{launch.description\}`\}/);
  assert.match(source, /title=\{launch.description\}/);
  assert.match(source, /<span>\{launch.label\}<\/span>/);
  assert.match(source, /controller.signal.aborted \|\| ticket !== epoch.current/);
  assert.match(source, /controller.abort\(\); clearTimeout\(timer\); epoch.current\+\+/);
  for (const rule of css.matchAll(/([^{}]*replay-review-launch[^{}]*)\{([^}]*)\}/g)) {
    // No independent padding/height/type size can reintroduce the reported mismatch.
    if (rule[1].includes('launch-symbol')) continue;
    assert.doesNotMatch(rule[2], /(?:^|;)\s*(?:padding|height|min-height|font-size|border-radius)\s*:/);
  }
});

test('actual review button starts with an honest loading state and remains a native disclosure button', async t => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configLoader: 'runner',
    server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  t.after(() => server.close());
  const { ReplayReviewCoach } = await server.ssrLoadModule('/src/components/ReplayReviewCoach.tsx');
  const markup = renderToStaticMarkup(createElement(ReplayReviewCoach, { match, currentStepIndex: 0,
    viewBefore: false, onJump() {} }));
  assert.match(markup, /<button type="button" class="sync-button replay-review-launch"/);
  assert.match(markup, /data-review-status="unknown"/);
  assert.match(markup, /aria-busy="true"/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, /aria-label="AI 复盘，正在读取复盘记录"/);
  assert.match(markup, /<span>AI 复盘<\/span>/);
  assert.doesNotMatch(markup, /data-review-status="ready"|已有复盘记录/);
});
