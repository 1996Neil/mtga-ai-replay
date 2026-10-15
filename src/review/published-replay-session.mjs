import { readPublishedReviewSource, validateCloudReviewBinding, adaptCloudReview } from './cloud-review.mjs';
import { fetchCloudReview } from './review-sync.mjs';
import { createComputePool } from '../compute-pool.mjs';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { reviewReject } from './cloud-review-contract.mjs';

/** Called inside a short-lived worker. The source capability is created from
 * exact bytes here, never accepted from a caller or persisted as a verdict. */
export async function historicalPublishedView({ sourceInput, report }) {
  const source = readPublishedReviewSource(sourceInput);
  if (!report || validateCloudReviewBinding(report, source).status !== 'ready') reviewReject('historical-report-binding');
  const result = await adaptCloudReview(report, source);
  const replayJson = JSON.stringify(source.replay);
  if (Buffer.byteLength(replayJson) > 128 * 1024 * 1024) reviewReject('historical-render-size');
  return { replay: source.replay, replayBytes: new TextEncoder().encode(replayJson), review: result.review, cards: source.cards,
    source: { revision: source.revision, content_hash: source.content_hash, match_id: source.match_id } };
}

async function freezeView(value) {
  const pending = [value], seen = new WeakSet(); let lastYield = performance.now();
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current); Object.freeze(current);
    for (const child of Object.values(current)) if (child && typeof child === 'object') pending.push(child);
    if (performance.now() - lastYield > 5) { await yieldLoop(); lastYield = performance.now(); }
  }
}

/** Explicit historical session with its own data directory and no local replay
 * loader, archive writer or normal review cache. Does not reinterpret local data. */
export async function openPublishedReplaySession({ matchId, gameNumber, revision, dataDir, ...options }) {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision ?? '') || !dataDir) reviewReject('historical-explicit-source');
  let pool = createComputePool();
  let fetched;
  try { fetched = await fetchCloudReview(matchId, gameNumber, { ...options, dataDir, revision, computePool: pool, deferSourceVerification: true }); }
  finally { await pool.close(); }
  pool = createComputePool();
  let view;
  const sourceStarted = performance.now();
  try { view = await pool.run('cloudReviewHistorical', { sourceInput: fetched.sourceInput, report: fetched.report }); }
  finally { await pool.close(); }
  options.onTiming?.({ stage: 'source-verification', duration_ms: performance.now() - sourceStarted });
  const freezeStarted = performance.now();
  const replayBytes = Buffer.from(view.replayBytes.buffer, view.replayBytes.byteOffset, view.replayBytes.byteLength);
  delete view.replayBytes; // Private encoded bytes never enter the mutable public view.
  await freezeView(view);
  options.onTiming?.({ stage: 'session-freeze', duration_ms: performance.now() - freezeStarted });
  const identity = Object.freeze({ kind: 'published-history', repository: fetched.repository, branch: fetched.branch,
    ...view.source, read_only: true, local_archive: false });
  // No session response can silently acquire the ordinary local-sync action.
  return { ...view, identity,
    replayProvider: { list: async () => [{ ...view.replay.match, game_count: view.replay.games.length, replay_revision: revision }],
      get: async id => id === matchId ? view.replay : null, latest: async () => view.replay,
      // Per-request copy protects the private wire snapshot from caller mutation.
      bytes: async id => id === matchId ? Buffer.from(replayBytes) : null },
    reviewReader: { read: async (id, game) => id === matchId && game === gameNumber
      ? { status: 'ready', can_sync: false, source_view: identity, review: view.review }
      : { code: 404, error: 'Unknown historical review.' },
    start: () => ({ code: 403, error: '历史发布源为固定版本，只读会话不接受同步写入。' }), close: async () => {} } };
}
