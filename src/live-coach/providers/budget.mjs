import { closeSync, openSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateJsonRead, privateJsonWrite, ProviderBlockedError } from './common.mjs';

// These are approved ceilings, not an automatic grant. A separate saved grant is required.
export const ACCEPTANCE_CEILINGS = Object.freeze({ maxPlanRequests: 20, maxTtsRequests: 30, maxChars: 6000, maxUsd: 1 });
// Rate sources: https://platform.minimax.io/docs/guides/pricing-paygo and https://elevenlabs.io/pricing/api
// The 2x reserve is a local stop threshold, not a claim about the final vendor invoice.
export const TTS_RESERVATION_USD_PER_CHAR = Object.freeze({ minimax: 0.00012, eleven: 0.00008 }); // 2x 2026-10-04 published system/premade-voice rates.

export function validateGrant(grant = {}) {
  const result = { approved: grant.approved === true, plan: grant.plan === true, minimax: grant.minimax === true, eleven: grant.eleven === true, apiCash: false, approvedAt: grant.approvedAt ?? null, expiresAt: grant.expiresAt ?? null };
  for (const [key, ceiling] of Object.entries(ACCEPTANCE_CEILINGS)) {
    const value = Number(grant[key] ?? 0);
    if (!Number.isFinite(value) || value < 0 || value > ceiling || (key !== 'maxUsd' && !Number.isInteger(value))) throw new ProviderBlockedError('invalid_grant', `Grant ${key} exceeds this phase's ceiling.`);
    result[key] = value;
  }
  if (result.expiresAt && (!Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now())) throw new ProviderBlockedError('grant_expired', 'The cloud-call grant has expired.');
  return Object.freeze(result);
}

export function saveGrant(filePath, grant) { const validated = validateGrant(grant); privateJsonWrite(filePath, validated); return validated; }
export function loadGrant(filePath) { return validateGrant(privateJsonRead(filePath) ?? {}); }

function validateLedger(data) {
  if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.some(entry =>
    !entry || typeof entry.id !== 'string' || !['plan', 'tts'].includes(entry.kind) ||
    !['openai-plan', 'minimax', 'eleven'].includes(entry.provider) ||
    (entry.kind === 'plan') !== (entry.provider === 'openai-plan') ||
    !Number.isInteger(entry.chars) || entry.chars < 0 ||
    !Number.isFinite(entry.reservedUsd) || entry.reservedUsd < 0 ||
    (entry.actualUsd != null && (!Number.isFinite(entry.actualUsd) || entry.actualUsd < 0)))) {
    throw new ProviderBlockedError('invalid_ledger', 'Unrecognized usage ledger; refusing to reset an existing budget.');
  }
  return data;
}

export class BudgetLedger {
  constructor({ filePath, grant = {} } = {}) {
    this.filePath = filePath;
    this.grant = validateGrant(grant);
    this.data = validateLedger(privateJsonRead(filePath ?? '') ?? { version: 1, entries: [] });
  }

  assertAuthorized(provider) {
    if (this.grant.expiresAt && Date.parse(this.grant.expiresAt) <= Date.now()) throw new ProviderBlockedError('grant_expired', 'The cloud-call grant has expired.');
    const key = provider === 'openai-plan' ? 'plan' : provider;
    if (!this.grant.approved || this.grant[key] !== true) throw new ProviderBlockedError('authorization_required', `${provider} is blocked until its explicit cloud-call grant is saved.`);
  }

  #transaction(callback) {
    if (!this.filePath) return callback();
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lockPath = `${this.filePath}.lock`;
    let descriptor;
    try { descriptor = openSync(lockPath, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new ProviderBlockedError('budget_busy', 'Another process owns the usage ledger; no request was sent.'); throw error; }
    try {
      const latest = privateJsonRead(this.filePath);
      if (latest) {
        this.data = validateLedger(latest);
      }
      const result = callback();
      privateJsonWrite(this.filePath, this.data);
      return result;
    } finally { closeSync(descriptor); unlinkSync(lockPath); }
  }

  reserve({ provider, kind, chars = 0, estimatedUsd = 0 }) {
    this.assertAuthorized(provider);
    if (!['plan', 'tts'].includes(kind) || (kind === 'plan') !== (provider === 'openai-plan') || !Number.isInteger(chars) || chars < 0 || !Number.isFinite(estimatedUsd) || estimatedUsd < 0) throw new ProviderBlockedError('invalid_reservation', 'Invalid cloud budget reservation.');
    return this.#transaction(() => {
      const total = this.summary();
      if ((kind === 'plan' && total.planRequests + 1 > this.grant.maxPlanRequests) ||
          (kind === 'tts' && total.ttsRequests + 1 > this.grant.maxTtsRequests) ||
          total.chars + chars > this.grant.maxChars || total.reservedUsd + estimatedUsd > this.grant.maxUsd + 1e-9) throw new ProviderBlockedError('budget_exhausted', 'Approved cloud budget reached; local observation can continue.');
      const entry = { id: randomUUID(), provider, kind, chars, reservedUsd: estimatedUsd, createdAt: new Date().toISOString(), status: 'reserved', usage: null, actualUsd: null };
      this.data.entries.push(entry);
      return entry.id;
    });
  }

  finish(id, { status = 'completed', usage = null, actualUsd = null } = {}) {
    return this.#transaction(() => {
      const entry = this.data.entries.find(item => item.id === id);
      if (!entry) throw new ProviderBlockedError('invalid_reservation', 'Missing usage reservation.');
      if (actualUsd != null && (!Number.isFinite(actualUsd) || actualUsd < 0)) throw new ProviderBlockedError('invalid_usage', 'Invalid provider billing amount.');
      Object.assign(entry, { status, usage, actualUsd, finishedAt: new Date().toISOString() });
      // A cancellation/failure never refunds reservation: remote billing may already have happened.
      return { ...entry };
    });
  }

  summary() {
    // Status readers must also see calls made by another authorized local command.
    if (this.filePath) {
      const persisted = privateJsonRead(this.filePath);
      if (persisted) this.data = validateLedger(persisted);
    }
    const total = { planRequests: 0, ttsRequests: 0, chars: 0, reservedUsd: 0, actualUsd: 0, estimatedCny: 0, unknownBillingRequests: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };
    for (const entry of this.data.entries) {
      if (entry.kind === 'plan') total.planRequests++; else total.ttsRequests++;
      total.chars += entry.chars;
      total.reservedUsd += Math.max(entry.reservedUsd, entry.actualUsd ?? 0);
      if (entry.actualUsd == null) total.unknownBillingRequests++; else total.actualUsd += entry.actualUsd;
      if (Number.isFinite(entry.usage?.estimated_cny)) total.estimatedCny += entry.usage.estimated_cny;
      for (const [target, source] of [['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens'], ['reasoningTokens', 'reasoning_tokens'], ['cachedInputTokens', 'cached_input_tokens']]) total[target] += Number(entry.usage?.[source] ?? 0);
    }
    // A CNY charge without a verified conversion is unknown in USD, never $0.
    return { ...total, reservedUsd: Number(total.reservedUsd.toFixed(8)), actualUsd: total.unknownBillingRequests ? null : Number(total.actualUsd.toFixed(8)), knownUsdSubtotal: Number(total.actualUsd.toFixed(8)), estimatedCny: Number(total.estimatedCny.toFixed(8)), actualUsdSource: 'returned_usage_times_documented_rate_not_invoice', estimatedCnySource: 'returned_billable_characters_times_mainland_tariff_not_invoice', limits: { ...this.grant }, source: 'local_reservations_and_returned_usage', independentGptApiCashUsd: 0, siwcCreditsUsage: 'not_reported_by_inference_contract' };
  }
}
