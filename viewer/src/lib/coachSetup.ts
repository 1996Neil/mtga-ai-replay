export type ModelProvider = 'siwc' | 'deepseek';
export type VoiceProvider = 'minimax' | 'eleven';
export type MinimaxRegion = 'china' | 'global';
export type StockVoice = { id: string; name: string; language?: string; gender?: string };
export type CoachSetup = {
  offline: boolean;
  auth: { provider: ModelProvider; selectedModel: string | null; selectionSource: 'local' | 'environment' | 'startup'; billing: string; signedIn: boolean; modelAvailable: boolean; availableModels: { slug: string; display_name: string; visibility: string }[]; blockedReason: string | null };
  voice: Record<VoiceProvider, { keyConfigured: boolean; keySource: 'local' | 'environment'; voiceSource: 'local' | 'environment'; voiceId: string | null; voices?: StockVoice[]; region?: MinimaxRegion; regionSource?: 'local' | 'environment' }>;
};
export type CoachSetupDraft = { minimaxKey: string; elevenKey: string; minimaxVoiceId: string; elevenVoiceId: string; minimaxRegion?: MinimaxRegion };
export type CoachSetupUpdate = { minimax_api_key?: string; elevenlabs_api_key?: string; minimax_voice_id?: string; eleven_voice_id?: string; minimax_region?: MinimaxRegion; model_provider?: ModelProvider; model_id?: string };

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const label = (value: unknown, limit = 200) => typeof value === 'string' ? value.slice(0, limit) : '';

export function stockVoices(value: unknown): StockVoice[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 1000).flatMap(item => {
    const entry = record(item), id = label(entry.id), name = label(entry.name);
    if (!id || !name || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name, ...(entry.language ? { language: label(entry.language) } : {}), ...(entry.gender ? { gender: label(entry.gender) } : {}) }];
  });
}

// Only retain the redacted setup fields. Keys and unrelated server data never enter UI state.
export function redactedCoachSetup(value: unknown): CoachSetup {
  const setup = record(value), auth = record(setup.auth), voice = record(setup.voice);
  const provider = (name: VoiceProvider): CoachSetup['voice'][VoiceProvider] => {
    const item = record(voice[name]);
    return { keyConfigured: item.keyConfigured === true,
      keySource: item.keySource === 'environment' ? 'environment' : 'local',
      voiceSource: item.voiceSource === 'environment' ? 'environment' : 'local', voiceId: label(item.voiceId) || null,
      ...(name === 'minimax' ? { region: item.region === 'china' ? 'china' : 'global', regionSource: item.regionSource === 'environment' ? 'environment' : 'local' } : {}),
      ...(Array.isArray(item.voices) ? { voices: stockVoices(item.voices) } : {}) };
  };
  const availableModels = Array.isArray(auth.availableModels) ? auth.availableModels.flatMap(item => {
    const model = record(item), slug = label(model.slug);
    return slug ? [{ slug, display_name: label(model.display_name) || slug, visibility: label(model.visibility) }] : [];
  }) : [];
  return { offline: setup.offline !== false, auth: { provider: auth.provider === 'deepseek' ? 'deepseek' : 'siwc', selectedModel: label(auth.selectedModel) || null, selectionSource: auth.selectionSource === 'startup' ? 'startup' : auth.selectionSource === 'environment' ? 'environment' : 'local', billing: label(auth.billing), signedIn: auth.signedIn === true,
    modelAvailable: auth.modelAvailable === true, availableModels, blockedReason: label(auth.blockedReason, 1000) || null },
    voice: { minimax: provider('minimax'), eleven: provider('eleven') } };
}

export function coachSetupUpdate(draft: CoachSetupDraft, sources?: CoachSetup['voice']): CoachSetupUpdate {
  const update: CoachSetupUpdate = {};
  for (const [field, value, source] of [['minimax_api_key', draft.minimaxKey, sources?.minimax.keySource], ['elevenlabs_api_key', draft.elevenKey, sources?.eleven.keySource],
    ['minimax_voice_id', draft.minimaxVoiceId, sources?.minimax.voiceSource], ['eleven_voice_id', draft.elevenVoiceId, sources?.eleven.voiceSource]] as const) {
    if (source === 'environment') continue;
    const clean = value.trim();
    const limit = field.endsWith('_api_key') ? 2048 : 200;
    if (clean.length > limit) throw new Error(field.endsWith('_api_key') ? '密钥长度不能超过 2048 个字符。' : '音色 ID 长度不能超过 200 个字符。');
    if (clean) update[field] = clean;
  }
  if (draft.minimaxRegion && sources?.minimax.regionSource !== 'environment' && draft.minimaxRegion !== sources?.minimax.region) {
    if (draft.minimaxRegion !== 'china' && draft.minimaxRegion !== 'global') throw new Error('请选择中国大陆或国际服务区域。');
    update.minimax_region = draft.minimaxRegion;
  }
  return update;
}

export function coachModelUpdate(provider: ModelProvider, modelId: string, current: CoachSetup['auth']): CoachSetupUpdate {
  if (current.selectionSource !== 'local') return {};
  if (!['siwc', 'deepseek'].includes(provider)) throw new Error('请选择已支持的模型供应商。');
  if (provider !== current.provider) return { model_provider: provider, model_id: '' };
  if (modelId === (current.selectedModel ?? '')) return {};
  if (modelId && !current.availableModels.some(row => row.slug === modelId)) throw new Error('请选择当前账户目录中的实际型号。');
  return { model_id: modelId };
}

async function request(action: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal): Promise<unknown> {
  try {
    const response = await fetch(`/api/live-coach/setup${action}`, { method, signal, credentials: 'same-origin',
      redirect: 'error', cache: 'no-store', headers: { 'X-MTGA-Coach-Action': 'session', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) });
    if (!response.ok) throw new Error();
    return await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('设置请求未完成，请检查本机服务、登录或已保存的密钥。');
  }
}

export async function readCoachSetup(signal?: AbortSignal) { return redactedCoachSetup(await request('', 'GET', undefined, signal)); }
export async function saveCoachSetup(update: CoachSetupUpdate, signal?: AbortSignal) { return redactedCoachSetup(await request('', 'POST', update, signal)); }
export async function refreshCoachModels(signal?: AbortSignal) { return redactedCoachSetup(await request('/models', 'POST', {}, signal)); }
export async function readCoachVoices(provider: VoiceProvider, signal?: AbortSignal) {
  const response = record(await request('/voices', 'POST', { provider }, signal));
  if (response.provider !== provider) throw new Error('音色目录与请求的服务不一致，请重试。');
  return stockVoices(response.voices);
}
