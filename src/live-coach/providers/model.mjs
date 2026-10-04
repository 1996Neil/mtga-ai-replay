// Contract: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
import { SELECTION_INSTRUCTIONS, selectionInput, parseSelection } from './selection.mjs';
import { checkedJson, operationSignal, ProviderBlockedError, sseJson } from './common.mjs';

export function responseUsage(usage) {
  if (!usage) return null;
  return { input_tokens: usage.input_tokens ?? null, output_tokens: usage.output_tokens ?? null, total_tokens: usage.total_tokens ?? null, reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? null, cached_input_tokens: usage.input_tokens_details?.cached_tokens ?? null };
}

export class PlanModelProvider {
  constructor({ auth, budget, model = 'gpt-6.1-sol', fetchImpl = globalThis.fetch, timeoutMs = 15000, siwc_plan_only_confirmed = false, planOnlyCheck = null } = {}) {
    this.auth = auth; this.budget = budget; this.model = model; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs;
    this.provider = 'siwc';
    this.catalog = null;
    this.catalogAccount = null;
    this.inflight = false;
    // SIWC identity/scopes/catalog do not prove that account credits fallback is off.
    // This separate explicit assurance must come from the user's app Usage settings check.
    this.planOnlyConfirmed = siwc_plan_only_confirmed === true;
    this.confirmedAccount = this.auth?.catalogKey?.() ?? null;
    this.planOnlyCheck = planOnlyCheck;
  }

  #assertPlanOnly() {
    if (this.planOnlyCheck && this.planOnlyCheck() !== true) this.planOnlyConfirmed = false;
    if (!this.planOnlyConfirmed) throw new ProviderBlockedError('siwc_plan_only_unconfirmed', 'Plan-only SIWC inference is blocked until you confirm this app’s credits fallback is disabled in ChatGPT Settings → Usage. Sign-in approval alone does not verify plan-only billing.');
    if ((this.auth?.catalogKey?.() ?? null) !== this.confirmedAccount) {
      this.planOnlyConfirmed = false;
      throw new ProviderBlockedError('siwc_plan_only_account_changed', 'The SIWC account registration changed. The previous credits-fallback confirmation no longer applies; verify credits are disabled for the selected app/account, then restart with renewed plan-only confirmation.');
    }
  }

  canUsePlanOnly() { try { this.#assertPlanOnly(); return true; } catch { return false; } }

  async availableModels({ signal } = {}) {
    this.budget?.assertAuthorized('openai-plan');
    if (!this.auth || !this.budget) throw new ProviderBlockedError('authorization_required', 'A SIWC account and explicit budget ledger are required.');
    const operation = operationSignal(signal, this.timeoutMs);
    try {
      const token = await this.auth.accessToken({ signal: operation.signal });
      const payload = await checkedJson(await this.fetchImpl('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${token}` }, signal: operation.signal }), 'OpenAI plan catalog');
      if (!Array.isArray(payload.models)) throw new ProviderBlockedError('invalid_catalog', 'SIWC model catalog did not contain the documented models array.');
      this.catalog = payload.models.filter(model => model.visibility === 'list' && typeof model.slug === 'string').map(model => ({ slug: model.slug, display_name: model.display_name ?? model.slug, visibility: model.visibility }));
      this.catalogAccount = this.auth.catalogKey?.() ?? null;
      return this.catalog;
    } finally { operation.dispose(); }
  }

  async select({ state, candidates, signal } = {}) {
    signal?.throwIfAborted();
    this.#assertPlanOnly();
    const input = selectionInput(state, candidates);
    if (this.inflight) throw new ProviderBlockedError('model_busy', 'Only one tactical model request may be active.');
    this.inflight = true;
    const operation = operationSignal(signal, this.timeoutMs);
    let reservation;
    let usage = null;
    try {
      if (!this.catalog || this.catalogAccount !== (this.auth.catalogKey?.() ?? null)) await this.availableModels({ signal: operation.signal });
      if (!this.catalog.some(model => model.slug === this.model)) throw new ProviderBlockedError('model_unavailable', `${this.model} was absent from the authorized account catalog; no alternate model or paid backend was selected.`);
      const token = await this.auth.accessToken({ signal: operation.signal });
      operation.signal.throwIfAborted();
      // Catalog/token awaits allow another local login to change the selected registration.
      this.#assertPlanOnly();
      reservation = this.budget.reserve({ provider: 'openai-plan', kind: 'plan' });
      const body = {
        model: this.model, store: false, stream: true, reasoning: { effort: 'low' },
        instructions: SELECTION_INSTRUCTIONS,
        input: [{ role: 'user', content: input }],
      };
      const response = await this.fetchImpl('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: operation.signal });
      if (!response.ok) await checkedJson(response, 'OpenAI plan inference');
      let completed = false;
      let text = '';
      for await (const event of sseJson(response.body, { signal: operation.signal })) {
        usage = responseUsage(event.response?.usage) ?? usage;
        if (event.type === 'response.output_text.delta') {
          text += event.delta ?? '';
          if (text.length > 8192) throw new ProviderBlockedError('model_output_too_large', 'Tactical selection exceeded its local output limit.');
        } else if (event.type === 'response.completed') {
          if (event.response?.status && event.response.status !== 'completed') throw new ProviderBlockedError('model_incomplete', 'The model terminal status was not completed.');
          completed = true;
          const outputText = event.response?.output?.flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text).join('');
          if (outputText) text = outputText;
          break;
        } else if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
          const code = event.response?.error?.code ?? event.error?.code ?? event.code ?? 'model_failed';
          throw new ProviderBlockedError(/^[a-z0-9_]{1,100}$/.test(code) ? code : 'model_failed', 'Plan inference failed or was incomplete; no paid fallback was attempted.');
        }
      }
      operation.signal.throwIfAborted();
      this.#assertPlanOnly();
      if (!completed) throw new ProviderBlockedError('model_missing_terminal', 'Stream ended without response.completed; partial output was discarded.');
      const selection = parseSelection(text, candidates);
      this.budget.finish(reservation, { status: 'completed', usage });
      reservation = null;
      return { ...selection, usage, provider: this.provider, model: this.model };
    } catch (error) {
      if (reservation) this.budget.finish(reservation, { status: operation.signal.aborted ? 'canceled_usage_unknown' : 'failed_usage_unknown', usage });
      throw error;
    } finally { operation.dispose(); this.inflight = false; }
  }
}

// Kept separate deliberately. Phase 1 has no authorization for billed GPT API calls.
export class StandardApiModelProvider {
  async availableModels() { throw new ProviderBlockedError('paid_api_not_authorized', 'Independent billed GPT API usage is not authorized for Phase 1.'); }
  async select() { throw new ProviderBlockedError('paid_api_not_authorized', 'Independent billed GPT API usage is not authorized; SIWC never falls back here.'); }
}
