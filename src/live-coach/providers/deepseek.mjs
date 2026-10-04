// Official protocol verified 2026-10-04. Account catalog/quality are not verified by contract tests.
// https://api-docs.deepseek.com/api/list-models
// https://api-docs.deepseek.com/api/create-chat-completion
import { operationSignal, ProviderBlockedError, checkedJson } from './common.mjs';
import { SELECTION_INSTRUCTIONS, selectionInput, parseSelection } from './selection.mjs';

export class DeepSeekModelProvider {
  constructor({ apiKey, budget, model = null, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    Object.assign(this, { apiKey, budget, model, fetchImpl, timeoutMs }); this.provider = 'deepseek'; this.catalog = null; this.inflight = false;
  }
  #authorized(metadata = false) {
    if (!this.budget) throw new ProviderBlockedError('paid_model_not_authorized', 'DeepSeek has no separate cash budget grant.');
    this.budget.assertAuthorized(this.model, { metadata });
    if (typeof this.apiKey !== 'string' || !this.apiKey || /\s/.test(this.apiKey)) throw new ProviderBlockedError('model_account_missing', 'DeepSeek credentials are not configured; no request was sent.');
  }
  canInfer() { try { this.#authorized(); return true; } catch { return false; } }
  async #json(url, options) {
    const response = await this.fetchImpl(url, { ...options, redirect: 'error', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' } });
    if (!response.ok) return checkedJson(response, 'DeepSeek');
    const reader = response.body?.getReader();
    if (!reader) throw new ProviderBlockedError('invalid_provider_json', 'DeepSeek returned no JSON body.');
    let size = 0; const chunks = [];
    const abort = () => { void reader.cancel().catch(() => {}); };
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        options.signal.throwIfAborted(); const { done, value } = await reader.read(); options.signal.throwIfAborted();
        if (done) break; size += value.byteLength;
        if (size > 256 * 1024) throw new ProviderBlockedError('model_output_too_large', 'DeepSeek response exceeded its local byte limit.');
        chunks.push(Buffer.from(value));
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new ProviderBlockedError('invalid_provider_json', 'DeepSeek returned malformed JSON; payload was not logged.'); }
    } finally { options.signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async availableModels({ signal } = {}) {
    this.#authorized(true); const operation = operationSignal(signal, this.timeoutMs);
    try {
      const payload = await this.#json('https://api.deepseek.com/models', { signal: operation.signal });
      if (!Array.isArray(payload.data) || payload.object !== 'list') throw new ProviderBlockedError('invalid_catalog', 'DeepSeek catalog did not contain the documented data array.');
      this.catalog = payload.data.filter(row => typeof row.id === 'string' && /^[a-z0-9._-]{1,200}$/.test(row.id)).map(row => ({ slug: row.id, display_name: row.name ?? row.id, visibility: 'list' }));
      return this.catalog;
    } finally { operation.dispose(); }
  }
  async select({ state, candidates, signal } = {}) {
    signal?.throwIfAborted(); this.#authorized();
    const input = selectionInput(state, candidates);
    if (this.inflight) throw new ProviderBlockedError('model_busy', 'Only one tactical model request may be active.');
    this.inflight = true; const operation = operationSignal(signal, this.timeoutMs); let reservation; let usage = null;
    try {
      if (!this.catalog) await this.availableModels({ signal: operation.signal });
      if (!this.catalog.some(row => row.slug === this.model)) throw new ProviderBlockedError('model_unavailable', 'Selected DeepSeek model was absent from the account catalog; no alternate was selected.');
      operation.signal.throwIfAborted(); this.#authorized();
      reservation = this.budget.reserve(this.model, Buffer.byteLength(input + SELECTION_INSTRUCTIONS, 'utf8') + 1024);
      const payload = await this.#json('https://api.deepseek.com/chat/completions', { method: 'POST', signal: operation.signal,
        body: JSON.stringify({ model: this.model, messages: [{ role: 'system', content: SELECTION_INSTRUCTIONS }, { role: 'user', content: input }],
          stream: false, thinking: { type: 'disabled' }, max_tokens: this.budget.grant.maxOutputTokens, response_format: { type: 'json_object' } }) });
      operation.signal.throwIfAborted(); this.#authorized();
      const tokens = payload.usage;
      usage = tokens ? { input_tokens: tokens.prompt_tokens ?? null, output_tokens: tokens.completion_tokens ?? null, total_tokens: tokens.total_tokens ?? null, cached_input_tokens: tokens.prompt_cache_hit_tokens ?? tokens.prompt_tokens_details?.cached_tokens ?? null } : null;
      if (payload.model !== this.model || payload.choices?.length !== 1 || payload.choices[0].finish_reason !== 'stop' || payload.choices[0].message?.tool_calls?.length) throw new ProviderBlockedError('model_incomplete', 'DeepSeek response was incomplete or did not match the selected model; discarded.');
      const selected = parseSelection(payload.choices[0].message?.content, candidates);
      this.budget.finish(reservation, { status: 'completed', usage }); reservation = null;
      return { ...selected, usage, provider: this.provider, model: this.model };
    } catch (error) {
      if (reservation) this.budget.finish(reservation, { status: operation.signal.aborted ? 'canceled_usage_unknown' : 'failed_usage_unknown', usage });
      throw error;
    } finally { operation.dispose(); this.inflight = false; }
  }
}
