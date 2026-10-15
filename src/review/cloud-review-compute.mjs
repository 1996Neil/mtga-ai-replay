import { readPublishedReviewSource, validateCloudReviewBinding, adaptCloudReview } from './cloud-review.mjs';
import { buildCoachBundle } from '../coach-bundle.mjs';
import { findReviewGame, replayInputFingerprintAsync, normalizeReplayReview } from './review-model.mjs';

/** Pure bounded worker task. Network, Git, credentials, cache and database writes
 * stay in the owning process. Source verdicts never cross the worker boundary. */
export async function verifyCloudReviewSync({ sourceInput, sourceMetadata, report, replay }) {
  const source = sourceInput ? await verifyCloudReviewSource({ sourceInput, report })
    : { status: 'ready', metadata: sourceMetadata };
  if (source.status !== 'ready') return { status: source.status };
  return verifyCloudReviewLocal({ sourceMetadata: source.metadata, report, replay });
}

/** The opaque source capability stays inside this invocation. Only the small
 * dictionary and binding metadata leave; no expanded board or verdict is sent. */
export async function verifyCloudReviewSource({ sourceInput, report }) {
    let source = readPublishedReviewSource(sourceInput);
    if (!report) return { status: 'missing' };
    if (validateCloudReviewBinding(report, source).status !== 'ready') return { status: 'stale' };
    await adaptCloudReview(report, source);
    const metadata = { cards: source.cards, history_key: source.history_key, content_hash: source.content_hash };
    // This is the worker's structured-cloned input. Drop verified parts and the
    // expanded source before allocating a second full bundle for local binding.
    // No caller-owned Map, source capability or durable record is mutated.
    source = null; sourceInput.files.clear(); sourceInput = undefined;
    return { status: 'ready', metadata };
}

export async function verifyCloudReviewLocal({ sourceMetadata: metadata, report, replay }) {
  const game = findReviewGame(replay, report.game_number);
  if (!game) return { status: 'stale' };
  const contentHash = (await buildCoachBundle(replay, { cards: metadata.cards, historyKey: metadata.history_key, multipart: true })).contentHash;
  if (contentHash !== metadata.content_hash) return { status: 'stale' };
  return { status: 'ready', fingerprint: await replayInputFingerprintAsync(replay) };
}

export async function presentCloudReview({ replay, report, expectedFingerprint }) {
  const fingerprint = await replayInputFingerprintAsync(replay);
  if (fingerprint !== expectedFingerprint) return { status: 'stale' };
  const review = normalizeReplayReview(replay, report.game_number, report, { source: 'cloud:chatgpt-cloud-agent',
    now: report.generated_at, fingerprint, cloudSemantics: true });
  review.summary.limitations = [...new Set([...report.coverage.limitations, ...review.summary.limitations])].slice(0, 4);
  return { status: 'ready', review: { ...review, cloud_schema: report.schema, source_content_hash: report.source_content_hash, coverage: report.coverage } };
}
