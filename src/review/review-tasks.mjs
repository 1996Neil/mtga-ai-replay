import { randomUUID } from 'node:crypto';
import { findReviewGame, normalizeReplayReview, reviewFingerprintAsync, REVIEW_POLICY } from './review-model.mjs';

// Server-owned, bounded ephemeral jobs; durable reports live in the sidecar only.
export function createReviewTasks({ loadReplay, readReview, writeReview, generate, deadlineMs = 180000 }) {
  const jobs = new Map(); let active, closing = false;
  const copy = job => job ? { id: job.id, status: job.status, progress: job.progress, error: job.error ?? null } : null;
  const keyOf = (id, game) => `${id}:${game}`;
  function cancel(id, game) {
    const job = jobs.get(keyOf(id, game));
    if (job?.status === 'running') job.controller.abort(new Error('Review cancelled.'));
    return copy(job);
  }
  async function read(id, gameNumber) {
    const replay = await loadReplay(id), game = findReviewGame(replay, gameNumber);
    if (!game) return { code: 404, error: 'Unknown game.' };
    const job = jobs.get(keyOf(id, gameNumber));
    if (job?.status === 'running') return { status: 'running', task: copy(job), can_generate: Boolean(generate) && !closing };
    const review = await readReview(id, gameNumber);
    if (!review) return { status: 'missing', task: copy(job), can_generate: Boolean(generate) && !closing };
    const fingerprint = await reviewFingerprintAsync(game, replay.warnings);
    if (review.match_id !== id || review.game_number !== gameNumber || review.policy_version !== REVIEW_POLICY || review.fingerprint !== fingerprint) {
      return { status: 'stale', task: copy(job), can_generate: Boolean(generate) && !closing };
    }
    return { status: 'ready', task: copy(job), can_generate: Boolean(generate) && !closing,
      review: normalizeReplayReview(replay, gameNumber, review, { source: review.source, now: review.created_at, fingerprint }) };
  }
  async function start(id, gameNumber) {
    if (closing) return { code: 503, error: 'Replay server is closing.' };
    if (active) return active.key === keyOf(id, gameNumber)
      ? { code: 202, status: 'running', task: copy(active) }
      : { code: 409, error: 'A review is already being generated.' };
    const controller = new AbortController();
    const job = { key: keyOf(id, gameNumber), id: randomUUID(), status: 'running', progress: { phase: 'preparing', completed: 0, total: 0 }, controller };
    active = job; jobs.set(job.key, job);
    // Bound retained status memory without losing an active task.
    while (jobs.size > 32) jobs.delete(jobs.keys().next().value);
    job.done = (async () => {
      let timer;
      try {
        timer = setTimeout(() => controller.abort(new Error('Review deadline exceeded.')), deadlineMs);
        const original = await loadReplay(id);
        controller.signal.throwIfAborted();
        const replay = structuredClone(original), game = findReviewGame(replay, gameNumber);
        if (!game) throw new Error('Unknown game.');
        const fingerprint = await reviewFingerprintAsync(game, replay.warnings, controller.signal);
        const cached = await readReview(id, gameNumber);
        controller.signal.throwIfAborted();
        if (cached?.policy_version === REVIEW_POLICY && cached.fingerprint === fingerprint && cached.match_id === id && cached.game_number === gameNumber) {
          job.status = 'succeeded'; return;
        }
        if (!generate) throw new Error('No review model configured; no request was sent.');
        let onAbort;
        const aborted = new Promise((_, reject) => {
          onAbort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', onAbort, { once: true });
          if (controller.signal.aborted) onAbort();
        });
        let generated;
        try {
          generated = await Promise.race([generate(replay, { gameNumber, signal: controller.signal, fingerprint,
            onProgress: progress => { if (job.status === 'running' && !controller.signal.aborted) job.progress = progress; } }), aborted]);
        } finally { controller.signal.removeEventListener('abort', onAbort); }
        controller.signal.throwIfAborted();
        const current = await loadReplay(id);
        const currentGame = findReviewGame(current, gameNumber);
        if (!currentGame || await reviewFingerprintAsync(currentGame, current.warnings, controller.signal) !== fingerprint) {
          job.status = 'stale'; job.error = '回放在分析期间已更新，未保存过期建议。'; return;
        }
        const review = normalizeReplayReview(replay, gameNumber, generated, { source: generated?.source ?? 'ai:custom', fingerprint });
        controller.signal.throwIfAborted();
        await writeReview(review);
        job.status = 'succeeded';
      } catch {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = controller.signal.aborted ? '分析已取消或超过总时限。' : 'AI 分析未完成；没有更改比赛记录。';
      } finally { clearTimeout(timer); if (active === job) active = null; }
    })();
    return { code: 202, status: 'running', task: copy(job) };
  }
  return { read, start, cancel, snapshot: (id, game) => copy(jobs.get(keyOf(id, game))),
    close: async () => { closing = true; active?.controller.abort(new Error('Server closing.')); await active?.done; } };
}
