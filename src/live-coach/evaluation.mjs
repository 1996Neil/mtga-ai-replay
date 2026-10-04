import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { generateCandidates, verifyCandidate } from './rules.mjs';
import { selectionInput } from './providers/selection.mjs';

// Same eight sanitized real windows for every provider. Five require selection;
// three must stay quiet locally. This is a safety/contract corpus, not a blind strategy exam.
export async function modelEvaluationCases() {
  const regression = JSON.parse(await readFile(new URL('../../tests/fixtures/live-coach-rule-windows.json', import.meta.url), 'utf8'));
  const heldout = JSON.parse(await readFile(new URL('../../tests/fixtures/live-coach-heldout-windows.json', import.meta.url), 'utf8'));
  return [...[0, 1, 5, 7, 8, 12, 18].map(index => regression.windows[index]), heldout.windows[0]].map((window, index) => {
    const candidates = generateCandidates(window.state).filter(candidate => verifyCandidate(candidate, window.state).valid);
    const input = selectionInputForCase(window.state, candidates);
    return { id: `real-window-${index + 1}`, source: window.source, state: window.state, candidates,
      input_sha256: createHash('sha256').update(input).digest('hex'), input_bytes: Buffer.byteLength(input),
      supported_scope: 'current_conditional_explanation_or_silence', strategy_grade: null };
  });
}
const selectionInputForCase = (state, candidates) => candidates.length ? selectionInput(state, candidates) : JSON.stringify({ state, candidates });

export async function evaluateModelCases(model, { evidenceMode, signal, cases } = {}) {
  if (!['offline_contract', 'real_service'].includes(evidenceMode)) throw new Error('Explicit evaluation evidence mode required.');
  cases ??= await modelEvaluationCases();
  const results = [];
  for (const entry of cases) {
    signal?.throwIfAborted();
    if (!entry.candidates.length) { results.push({ case_id: entry.id, input_sha256: entry.input_sha256, result: 'local_silence', model_requested: false, strategy_correct: null }); continue; }
    const start = performance.now(), selected = await model.select({ state: entry.state, candidates: entry.candidates, signal });
    signal?.throwIfAborted();
    const chosen = entry.candidates.find(candidate => candidate.action_id === selected.action_id);
    const valid = selected.action_id === null || Boolean(chosen && verifyCandidate(chosen, entry.state).valid);
    if (!valid) throw new Error('Evaluation rejected a selection outside the locally verified subset.');
    results.push({ case_id: entry.id, state_id: entry.state.state_id, input_sha256: entry.input_sha256,
      result: selected.action_id === null ? 'model_silence' : 'verified_candidate', model_requested: true,
      action_id: selected.action_id, reason: selected.reason, provider_selection_ms: performance.now() - start, usage: selected.usage,
      selection_contract_pass: true, strategy_correct: null, human_reason_quality: null, acoustic_first_sound_ms: null });
  }
  return { provider: model.provider ?? null, model: model.model ?? null, evidence_mode: evidenceMode,
    results, model_requests: results.filter(row => row.model_requested).length,
    model_quality_verified: false, strategy_independently_adjudicated: false, acoustic_metrics_verified: false,
    model_usage: model.budget?.summary?.() ?? null };
}
