/** Aggregate repeated phases using a monotonic clock, including security
 * checks interleaved with generation/remote work. No paths or payloads. */
export function createSyncProgress(onProgress) {
  const started = performance.now(), timings = {};
  let phase = null, changed = started, counts = {};
  const account = now => { if (phase) timings[phase] = (timings[phase] ?? 0) + now - changed; changed = now; };
  return {
    emit(value) {
      const now = performance.now(); account(now);
      phase = value.phase;
      if (value.total !== undefined) counts = { completed: value.completed ?? 0, total: value.total };
      onProgress?.({ ...counts, ...value, elapsed_ms: Math.round(now - started), timings_ms: Object.fromEntries(Object.entries(timings).map(([key, ms]) => [key, Math.round(ms)])) });
    },
    finish() { const now = performance.now(); account(now); return { duration_ms: Math.round(now - started), timings_ms: Object.fromEntries(Object.entries(timings).map(([key, ms]) => [key, Math.round(ms)])) }; },
  };
}
