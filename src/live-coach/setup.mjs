import { readCoachConfig, saveVoiceConfig } from './config.mjs';
import { MiniMaxVoiceProvider, ElevenVoiceProvider } from './providers/index.mjs';

const safeText = value => typeof value === 'string' ? value.slice(0, 200).replace(/[\x00-\x1f]/g, '') : null;

/** Own local setup surface. Metadata calls never select a model or synthesize speech. */
export class CoachSetup {
  constructor({ directory, auth, model, budget, controller, offline = true, modelFactory = null, modelSelection = {},
    miniFactory = options => new MiniMaxVoiceProvider(options),
    elevenFactory = options => new ElevenVoiceProvider(options) }) {
    Object.assign(this, { directory, auth, model, budget, controller, offline, miniFactory, elevenFactory, modelFactory, modelSelection });
    this.providers = {}; this.voices = {}; this.revision = 0; this.busy = false; this.reconfiguring = false;
  }
  async initialize() { this.config = await readCoachConfig(this.directory, this.modelSelection); this.#providers(); this.#apply(); return this; }
  #providers() {
    this.providers = { minimax: this.config.minimaxKey ? this.miniFactory({ apiKey: this.config.minimaxKey, budget: this.budget, region: this.config.minimaxRegion }) : null,
      eleven: this.config.elevenKey ? this.elevenFactory({ apiKey: this.config.elevenKey, budget: this.budget }) : null };
    this.voices = {};
  }
  #catalogCurrent() { return this.config.modelProvider === 'deepseek' ? this.model.provider === 'deepseek' : this.model.catalogAccount === this.auth.catalogKey(); }
  #modelReason() {
    if (!this.config.modelId) return '请先从实际账户目录明确选择型号；尚未启用模型推理。';
    if (this.config.modelProvider === 'deepseek') {
      if (!this.model.canInfer?.()) return 'DeepSeek 尚无单独的凭据与付费推理授权；现有 SIWC/TTS 授权不适用。';
      if (!this.model.catalog) return '尚未读取 DeepSeek 账户目录；未将官方示例当成账户可用性。';
      return this.model.catalog.some(row => row.slug === this.config.modelId) ? null : '所选型号不在 DeepSeek 账户目录；未替换后端。';
    }
    if (!this.auth.summary().signedIn) return '尚未完成官方 SIWC 登录。';
    if (!this.model.catalog || this.model.catalogAccount !== this.auth.catalogKey()) return '尚未读取当前账户的模型目录。';
    if (!this.model.catalog.some(row => row.slug === this.config.modelId)) return `当前官方账户目录没有所选型号 ${this.config.modelId}；未替换型号或收费后端。`;
    if (!this.config.siwcPlanOnlyConfirmed) return '尚未确认此 app 的 credits fallback 已关闭；推理暂停。';
    if (this.model.canUsePlanOnly?.() === false) return '本进程的计划额度确认已失效；请核实 credits fallback 并重新启动教练。';
    return null;
  }
  #apply() {
    this.controller.voice = this.offline ? null : this.providers.minimax;
    this.controller.voiceId = this.config.minimaxVoiceId;
    this.controller.modelLedger = this.config.modelProvider === 'deepseek' ? this.model.budget : null;
    const reason = this.#modelReason();
    this.controller.model = !this.offline && !reason ? this.model : null;
    this.controller.modelStatus = this.offline ? 'offline: cloud generation disabled' : reason ?? `${this.config.modelProvider} / ${this.config.modelId} / verified account catalog`;
    this.controller.publish('status', this.controller.snapshot());
  }
  snapshot() {
    const catalogCurrent = this.#catalogCurrent();
    const availableModels = catalogCurrent ? (this.model.catalog ?? []).map(row => ({ slug: row.slug, display_name: row.display_name, visibility: row.visibility })) : [];
    const providerStatus = name => ({ keyConfigured: Boolean(name === 'minimax' ? this.config.minimaxKey : this.config.elevenKey),
      voiceId: name === 'minimax' ? this.config.minimaxVoiceId : this.config.elevenVoiceId,
      keySource: process.env[name === 'minimax' ? 'MINIMAX_API_KEY' : 'ELEVENLABS_API_KEY'] ? 'environment' : 'local',
      voiceSource: process.env[name === 'minimax' ? 'MINIMAX_VOICE_ID' : 'ELEVENLABS_VOICE_ID'] ? 'environment' : 'local',
      ...(name === 'minimax' ? { region: this.config.minimaxRegion, regionSource: process.env.MINIMAX_REGION ? 'environment' : 'local' } : {}),
      voices: this.voices[name] ?? [] });
    return { offline: this.offline, auth: { signedIn: this.auth.summary().signedIn,
      provider: this.config.modelProvider, selectedModel: this.config.modelId,
      selectionSource: this.modelSelection.model || this.modelSelection.provider ? 'startup' : process.env.MTGA_COACH_MODEL || process.env.MTGA_COACH_MODEL_PROVIDER ? 'environment' : 'local',
      billing: this.config.modelProvider === 'deepseek' ? 'separate_paid_api_grant_required' : 'siwc_plan_only_confirmation_required',
      modelAvailable: availableModels.some(row => row.slug === this.config.modelId), availableModels, blockedReason: this.#modelReason() },
      voice: { minimax: providerStatus('minimax'), eleven: providerStatus('eleven') },
      grant: { approved: this.config.grant.approved === true, maxPlanRequests: this.config.grant.maxPlanRequests ?? 0,
        maxTtsRequests: this.config.grant.maxTtsRequests ?? 0, maxChars: this.config.grant.maxChars ?? 0, maxUsd: this.config.grant.maxUsd ?? 0 }, usage: this.budget.summary(), modelUsage: this.config.modelProvider === 'deepseek' ? this.model.budget.summary() : null };
  }
  async save(input) {
    if (this.busy) throw new Error('setup_busy');
    this.busy = true; this.reconfiguring = true; this.controller.mute(); ++this.revision;
    try {
      const previous = this.config;
      await saveVoiceConfig(input, this.directory);
      this.config = await readCoachConfig(this.directory, this.modelSelection);
      if (previous.modelProvider !== this.config.modelProvider || previous.modelId !== this.config.modelId) {
        const old = this.model;
        if (this.modelFactory) this.model = this.modelFactory(this.config);
        else if (this.config.modelProvider === 'siwc') this.model.model = this.config.modelId;
        else throw new Error('model_factory_missing');
        if (this.model !== old && previous.modelProvider === this.config.modelProvider && previous.modelProvider === 'siwc' && old.catalogAccount === this.auth.catalogKey()) {
          this.model.catalog = old.catalog; this.model.catalogAccount = old.catalogAccount;
        } else if (this.model !== old && previous.modelProvider === this.config.modelProvider && this.config.modelProvider === 'deepseek' && old.apiKey === this.model.apiKey) {
          this.model.catalog = old.catalog;
        }
      }
      this.#providers(); this.#apply(); return this.snapshot(); }
    finally {
      // Requests from another tab cannot restart the old provider while a save is pending.
      // Previously blocked speech must be eligible again after an explicit resume/observe.
      this.controller.mute(); this.controller.reset('voice_configuration_changed');
      this.reconfiguring = false; this.busy = false;
    }
  }
  async availableVoices(provider) {
    if (!['minimax', 'eleven'].includes(provider) || !this.providers[provider] || this.busy) throw new Error('voice_account_missing_or_setup_busy');
    this.busy = true; const revision = this.revision, request = new AbortController(); this.metadataRequest = request;
    try {
      const rows = await this.providers[provider].availableVoices({ signal: request.signal });
      request.signal.throwIfAborted();
      if (revision !== this.revision) throw new Error('setup_changed');
      const voices = rows.slice(0, 1000).map(row => ({ id: safeText(row.voice_id), name: safeText(row.voice_name ?? row.name ?? row.voice_id),
        language: safeText(Array.isArray(row.language) ? row.language.join(', ') : row.language ?? row.labels?.language), gender: safeText(row.gender ?? row.labels?.gender) })).filter(row => row.id);
      this.voices[provider] = voices;
      return { provider, voices };
    } finally { if (this.metadataRequest === request) this.metadataRequest = null; this.busy = false; }
  }
  async refreshModels() {
    if (this.busy) throw new Error('setup_busy');
    this.busy = true; const request = new AbortController(); this.metadataRequest = request;
    try {
      const latest = await readCoachConfig(this.directory, this.modelSelection);
      this.config.siwcPlanOnlyConfirmed = latest.siwcPlanOnlyConfirmed;
      if (this.config.modelProvider === 'siwc' && !latest.siwcPlanOnlyConfirmed) this.model.planOnlyConfirmed = false;
      await this.model.availableModels({ signal: request.signal }); request.signal.throwIfAborted(); this.#apply(); return this.snapshot();
    }
    finally { if (this.metadataRequest === request) this.metadataRequest = null; this.busy = false; }
  }
  cancelMetadata() { this.metadataRequest?.abort(new DOMException('Coach setup query stopped.', 'AbortError')); }
}
