import { openSync, closeSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateJsonRead, privateJsonWrite, ProviderBlockedError } from './common.mjs';

// A separate grant/ledger: existing SIWC/TTS permission never authorizes cash inference.
export const DEEPSEEK_CEILINGS = Object.freeze({ maxRequests: 12, maxUsd: 0.25, maxInputBytes: 65536, maxOutputTokens: 256 });
// Peak, cache-miss USD/1M token ceiling verified 2026-10-04; no off-peak/cache discount is assumed.
// https://api-docs.deepseek.com/quick_start/pricing
export const DEEPSEEK_RATES = Object.freeze({ 'deepseek-flash': { input: 0.3, output: 1.2 }, 'deepseek-v4-pro': { input: 1.32, output: 3.96 } });
const blocked = message => new ProviderBlockedError('paid_model_not_authorized', message);
export class PaidModelBudget {
  constructor({ filePath, grant = {} } = {}) {
    this.filePath = filePath; this.grant = { ...grant };
    this.data = this.#read();
  }
  #read() {
    const data = privateJsonRead(this.filePath ?? '') ?? { version: 1, entries: [] };
    if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.some(entry => !entry || typeof entry.id !== 'string' ||
      !Number.isFinite(entry.reservedUsd) || entry.reservedUsd <= 0 || !['deepseek-flash', 'deepseek-v4-pro'].includes(entry.model))) {
      throw new ProviderBlockedError('invalid_ledger', 'Unrecognized paid model ledger; refusing to reset it.');
    }
    return data;
  }
  assertAuthorized(model, { metadata = false } = {}) {
    const grant = this.grant;
    if (grant.approved !== true || grant.provider !== 'deepseek' || (!metadata && grant.model !== model) ||
      (metadata ? grant.metadata !== true : grant.inference !== true)) throw blocked('DeepSeek needs its own explicit model, metadata and cash-call grant; existing Phase 1 grants do not apply.');
    if (!grant.expiresAt || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()) throw blocked('The separate DeepSeek grant is absent or expired.');
    if (!Object.hasOwn(DEEPSEEK_RATES, metadata ? grant.model : model)) throw blocked('This model has no verified local price ceiling; no alternate was selected.');
    for (const [key, ceiling] of Object.entries(DEEPSEEK_CEILINGS)) {
      if (!Number.isFinite(grant[key]) || grant[key] <= 0 || grant[key] > ceiling || (key !== 'maxUsd' && !Number.isInteger(grant[key]))) throw blocked('The separate DeepSeek grant needs bounded request, token and cash limits.');
    }
  }
  #transaction(callback) {
    if (!this.filePath) return callback();
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    let lock;
    try {
      try { lock = openSync(`${this.filePath}.lock`, 'wx', 0o600); }
      catch { throw new ProviderBlockedError('budget_busy', 'The separate paid-model ledger is busy; no request was sent.'); }
      this.data = this.#read(); const result = callback(); privateJsonWrite(this.filePath, this.data); return result;
    } finally { if (lock !== undefined) { closeSync(lock); unlinkSync(`${this.filePath}.lock`); } }
  }
  reserve(model, inputBytes) {
    this.assertAuthorized(model);
    if (!Number.isSafeInteger(inputBytes) || inputBytes <= 0 || inputBytes > this.grant.maxInputBytes) throw new ProviderBlockedError('model_input_too_large', 'Model input exceeded its approved byte ceiling.');
    // Reserve UTF-8 bytes as tokens, including caller padding for chat framing.
    // This is a conservative local reservation at the verified tariff, not an invoice.
    const rates = DEEPSEEK_RATES[model], reservedUsd = (inputBytes * rates.input + this.grant.maxOutputTokens * rates.output) / 1e6;
    return this.#transaction(() => {
      if (this.data.entries.length >= this.grant.maxRequests || this.data.entries.reduce((sum, entry) => sum + entry.reservedUsd, 0) + reservedUsd > this.grant.maxUsd + 1e-9) throw new ProviderBlockedError('budget_exhausted', 'Approved DeepSeek budget reached; no request was sent.');
      const entry = { id: randomUUID(), model, inputBytes, maxOutputTokens: this.grant.maxOutputTokens, reservedUsd, status: 'reserved', usage: null, actualUsd: null, createdAt: new Date().toISOString() };
      this.data.entries.push(entry); return entry.id;
    });
  }
  finish(id, { status, usage = null } = {}) {
    return this.#transaction(() => {
      const entry = this.data.entries.find(entry => entry.id === id);
      if (!entry) throw new ProviderBlockedError('invalid_reservation', 'Missing paid-model reservation.');
      Object.assign(entry, { status, usage, finishedAt: new Date().toISOString() });
      // Failed/canceled calls keep the full ceiling. Returned token usage is not an invoice.
    });
  }
  summary() {
    if (this.filePath) this.data = this.#read();
    return { provider: 'deepseek', requests: this.data.entries.length, reservedUsd: Number(this.data.entries.reduce((sum, entry) => sum + entry.reservedUsd, 0).toFixed(8)),
      actualUsd: null, source: 'conservative_peak_cache_miss_reservations_not_invoice', limits: Object.fromEntries(Object.keys(DEEPSEEK_CEILINGS).map(key => [key, this.grant[key] ?? 0])), ceilings: DEEPSEEK_CEILINGS };
  }
}
