import { join } from 'node:path';
import { privateJsonRead, ProviderBlockedError } from './providers/common.mjs';
import { validateGrant, TTS_RESERVATION_USD_PER_CHAR } from './providers/budget.mjs';
import { DEEPSEEK_RATES } from './providers/paid-model-budget.mjs';
import { SELECTION_INSTRUCTIONS, selectionInput } from './providers/selection.mjs';

const same = (left, right) => JSON.stringify(Object.entries(left ?? {}).sort()) === JSON.stringify(Object.entries(right ?? {}).sort());
const block = (code, message) => { throw new ProviderBlockedError(code, message); };

/** Read-only preflight for standby. Provider reservations remain authoritative;
 * no grants, credentials, balances or accounts are written or reset here. */
export function attachStandbyGuard(runtime) {
  const setup = runtime.setup;
  const currentGrants = () => {
    const saved = privateJsonRead(join(setup.directory, 'config.json')) ?? {};
    if (!same(validateGrant(saved.grant ?? {}), setup.budget.grant) ||
      (setup.config.modelProvider === 'deepseek' && !same(saved.deepseek_grant, setup.model.budget.grant))) {
      block('grant_changed', 'Saved authorization changed; restart after checking the existing grant. No grant was renewed.');
    }
  };
  // Recheck saved authorization at original provider boundaries after awaits.
  // These hooks never grant permission or replace the provider's reservation.
  const guardedBudgets = new WeakSet();
  const guardBudget = budget => {
    if (guardedBudgets.has(budget)) return;
    guardedBudgets.add(budget);
    const assertAuthorized = budget.assertAuthorized.bind(budget);
    budget.assertAuthorized = (...args) => { currentGrants(); return assertAuthorized(...args); };
  };
  const guardProvider = (provider, kind) => {
    if (!provider) return provider;
    guardBudget(provider.budget);
    const fetch = provider.fetchImpl;
    provider.fetchImpl = (url, ...args) => {
      currentGrants();
      if (kind === 'model' && provider.provider === 'deepseek') provider.budget.assertAuthorized(provider.model, { metadata: url === 'https://api.deepseek.com/models' });
      else setup.budget.assertAuthorized(kind === 'model' ? 'openai-plan' : kind);
      return fetch.call(provider, url, ...args);
    };
    return provider;
  };
  guardBudget(setup.budget);
  guardProvider(setup.model, 'model');
  for (const kind of ['minimax', 'eleven']) guardProvider(setup.providers[kind], kind);
  for (const [name, kind] of [['modelFactory', 'model'], ['miniFactory', 'minimax'], ['elevenFactory', 'eleven']]) {
    const factory = setup[name];
    if (factory) setup[name] = (...args) => guardProvider(factory(...args), kind);
  }
  const accessToken = setup.auth.accessToken.bind(setup.auth), authFetch = setup.auth.fetchImpl;
  setup.auth.accessToken = async (...args) => {
    currentGrants(); setup.budget.assertAuthorized('openai-plan');
    const token = await accessToken(...args);
    currentGrants(); setup.budget.assertAuthorized('openai-plan'); return token;
  };
  setup.auth.fetchImpl = (...args) => { currentGrants(); setup.budget.assertAuthorized('openai-plan'); return authFetch.apply(setup.auth, args); };
  const voice = (provider = 'minimax', chars = 1) => {
    if (!['minimax', 'eleven'].includes(provider)) block('voice_account_missing', 'Unknown voice provider.');
    setup.budget.assertAuthorized(provider);
    const total = setup.budget.summary(), grant = setup.budget.grant;
    const units = chars * (provider === 'minimax' && setup.config.minimaxRegion === 'china' ? 2 : 1);
    const cost = units * TTS_RESERVATION_USD_PER_CHAR[provider];
    if (total.ttsRequests + 1 > grant.maxTtsRequests || total.chars + units > grant.maxChars || total.reservedUsd + cost > grant.maxUsd + 1e-9) {
      block('budget_exhausted', 'No approved speech budget remains; no request was sent.');
    }
  };
  const model = (state, options, metadata = false) => {
    if (setup.config.modelProvider === 'deepseek') {
      const paid = setup.model.budget;
      paid.assertAuthorized(setup.config.modelId, { metadata });
      const bytes = state ? Buffer.byteLength(selectionInput(state, options) + SELECTION_INSTRUCTIONS, 'utf8') + 1024 : 1;
      const total = paid.summary(), grant = paid.grant, rates = DEEPSEEK_RATES[metadata ? grant.model : setup.config.modelId];
      if (bytes > grant.maxInputBytes) block('model_input_too_large', 'Model input exceeds the existing approved byte ceiling.');
      const cost = (bytes * rates.input + grant.maxOutputTokens * rates.output) / 1e6;
      if (total.requests + 1 > grant.maxRequests || total.reservedUsd + cost > grant.maxUsd + 1e-9) block('budget_exhausted', 'No approved model budget remains; no request was sent.');
    } else {
      setup.budget.assertAuthorized('openai-plan');
      if (setup.budget.summary().planRequests + 1 > setup.budget.grant.maxPlanRequests) block('budget_exhausted', 'No approved plan requests remain; no request was sent.');
    }
  };
  const guard = {
    beforeVoice(text) {
      currentGrants();
      voice('minimax', text.length);
    },
    metadata(kind, provider) {
      currentGrants();
      if (kind === 'voice') voice(provider);
      else {
        // Catalog access keeps its existing separate metadata authorization.
        model(undefined, undefined, true);
      }
    },
    ready(state, options) {
      currentGrants();
      if (setup.busy || setup.reconfiguring) block('setup_busy', 'Finish or cancel the explicit setup action before enabling.');
      model(state, options);
      const chars = options ? Math.max(...options.map(row => [row.speech_core, row.speech_followup].filter(Boolean).join(' ').length)) : 1;
      voice('minimax', chars);
      if (!setup.controller.model || setup.snapshot().auth.blockedReason) block('model_not_ready', 'Read and select the authorized model in the existing setup UI before enabling.');
      if (!setup.controller.voice || !setup.config.minimaxVoiceId) block('voice_account_missing', 'Configure the existing authorized voice account and system voice before enabling.');
    }
  };
  runtime.standbyGuard = guard;
  runtime.controller.beforeGenerate = (state, options) => guard.ready(state, options);
  runtime.controller.beforeVoice = text => guard.beforeVoice(text);
  // Advertise only after all standby hooks have actually been attached.
  runtime.controller.standbyGuardVersion = 'replay-standby-v1';
  return guard;
}
