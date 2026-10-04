import { privateJsonRead, privateJsonWrite } from './providers/common.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const coachConfigDir = () => join(homedir(), '.local', 'share', 'mtga-live-coach');
export const PHASE1_GRANT = Object.freeze({ approved: true, plan: true, minimax: true, eleven: true,
  maxPlanRequests: 20, maxTtsRequests: 30, maxChars: 6000, maxUsd: 1,
  purpose: 'phase1-20261004', paidOpenAI: false, microphone: false, livePractice: false });

export async function readCoachConfig(directory = coachConfigDir(), selection = {}) {
  const optionalJson = async name => privateJsonRead(join(directory, name)) ?? {};
  const config = await optionalJson('config.json'), credentials = await optionalJson('credentials.json');
  const minimaxRegion = process.env.MINIMAX_REGION || config.minimax_region || 'global';
  if (!['global', 'china'].includes(minimaxRegion)) throw new Error('invalid_minimax_region');
  const modelProvider = selection.provider || process.env.MTGA_COACH_MODEL_PROVIDER || config.model_provider || 'siwc';
  if (!['siwc', 'deepseek'].includes(modelProvider)) throw new Error('invalid_model_provider');
  const modelId = selection.model || process.env.MTGA_COACH_MODEL || (modelProvider !== (config.model_provider || 'siwc') ? null : Object.hasOwn(config, 'model_id') ? config.model_id : modelProvider === 'siwc' ? 'gpt-6.1-sol' : null);
  if (modelId !== null && (typeof modelId !== 'string' || !/^[a-z0-9._-]{1,200}$/.test(modelId))) throw new Error('invalid_model_id');
  return { directory, grant: config.grant ?? { approved: false },
    modelProvider, modelId,
    deepseekKey: modelProvider === 'deepseek' ? process.env.DEEPSEEK_API_KEY || credentials.deepseek_api_key || null : null,
    deepseekGrant: config.deepseek_grant ?? { approved: false },
    minimaxRegion,
    minimaxKey: process.env.MINIMAX_API_KEY || credentials.minimax_api_key || null,
    elevenKey: process.env.ELEVENLABS_API_KEY || credentials.elevenlabs_api_key || null,
    minimaxVoiceId: process.env.MINIMAX_VOICE_ID || config.minimax_voice_id || null,
    elevenVoiceId: process.env.ELEVENLABS_VOICE_ID || config.eleven_voice_id || null,
    siwcPlanOnlyConfirmed: config.siwc_plan_only_confirmed === true,
    siwcPlanOnlyRevision: config.siwc_plan_only_revision ?? null,
    livePractice: config.live_practice_approved === true && config.grant?.livePractice === true };
}

/** Only called once by the integrator after the user's explicit 2026-10-04 grant. */
export async function savePhase1Grant(directory = coachConfigDir()) {
  const path = join(directory, 'config.json');
  const previous = privateJsonRead(path) ?? {};
  privateJsonWrite(path, { ...previous, grant: PHASE1_GRANT });
  return path;
}

export function clearSiwcPlanOnlyConfirmation(directory = coachConfigDir()) {
  const path = join(directory, 'config.json'), previous = privateJsonRead(path) ?? {};
  privateJsonWrite(path, { ...previous, siwc_plan_only_confirmed: false, siwc_plan_only_revision: randomUUID() });
}

export function currentPlanOnlyConfirmation(directory, revision) {
  const config = privateJsonRead(join(directory, 'config.json')) ?? {};
  return config.siwc_plan_only_confirmed === true && (config.siwc_plan_only_revision ?? null) === revision;
}

/** Local setup only: never edits an authorization, account token or usage ledger. */
export async function saveVoiceConfig(input, directory = coachConfigDir()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_voice_config');
  const keyFields = ['minimax_api_key', 'elevenlabs_api_key'];
  const voiceFields = ['minimax_voice_id', 'eleven_voice_id'];
  if (Object.keys(input).some(key => ![...keyFields, ...voiceFields, 'minimax_region', 'model_provider', 'model_id'].includes(key))) throw new Error('invalid_voice_config');
  if (Object.hasOwn(input, 'minimax_region') && !['global', 'china'].includes(input.minimax_region)) throw new Error('invalid_minimax_region');
  if (Object.hasOwn(input, 'model_provider') && !['siwc', 'deepseek'].includes(input.model_provider)) throw new Error('invalid_model_provider');
  if (Object.hasOwn(input, 'model_id') && input.model_id !== '' && !/^[a-z0-9._-]{1,200}$/.test(input.model_id)) throw new Error('invalid_model_id');
  // Validate the entire request before writing anything. Blank password means keep it.
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string' || /[\r\n\x00]/.test(value) || value.length > (keyFields.includes(name) ? 2048 : 200)) throw new Error('invalid_voice_config');
    if (keyFields.includes(name) && value.trim() && /\s/.test(value)) throw new Error('invalid_voice_config');
  }
  const credentialsPath = join(directory, 'credentials.json'), configPath = join(directory, 'config.json');
  const credentials = privateJsonRead(credentialsPath) ?? {}, config = privateJsonRead(configPath) ?? {};
  let keysChanged = false, voicesChanged = false;
  for (const name of keyFields) if (input[name]?.trim()) { credentials[name] = input[name]; keysChanged = true; }
  for (const name of voiceFields) if (Object.hasOwn(input, name)) { config[name] = input[name].trim() || null; voicesChanged = true; }
  if (Object.hasOwn(input, 'minimax_region')) { config.minimax_region = input.minimax_region; voicesChanged = true; }
  if (Object.hasOwn(input, 'model_provider')) {
    if (input.model_provider !== (config.model_provider ?? 'siwc')) config.model_id = null;
    config.model_provider = input.model_provider; voicesChanged = true;
  }
  if (Object.hasOwn(input, 'model_id')) { config.model_id = input.model_id || null; voicesChanged = true; }
  if (keysChanged) privateJsonWrite(credentialsPath, credentials);
  if (voicesChanged) privateJsonWrite(configPath, config);
  return readCoachConfig(directory);
}
