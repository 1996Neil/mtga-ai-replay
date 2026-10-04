// HTTPS streaming preserves Node's default certificate verification.
// Contract: https://platform.minimax.io/docs/api-reference/speech-t2a-http
import { assertText, checkedJson, operationSignal, ProviderBlockedError, sseJson } from './common.mjs';
import { TTS_RESERVATION_USD_PER_CHAR } from './budget.mjs';

const EMOTIONS = { neutral: 'calm', calm: 'calm', excited: 'happy', happy: 'happy', disappointed: 'sad', sad: 'sad', correction: 'calm', surprised: 'surprised' };

export class MiniMaxVoiceProvider {
  constructor({ apiKey = process.env.MINIMAX_API_KEY, budget, voiceId, region = 'global', fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    if (!['global', 'china'].includes(region)) throw new ProviderBlockedError('invalid_minimax_region', 'MiniMax region must be global or china; arbitrary hosts are not accepted.');
    this.region = region; this.baseUrl = region === 'china' ? 'https://api.minimax.cn' : 'https://api.minimax.io';
    this.apiKey = apiKey; this.budget = budget; this.voiceId = voiceId; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs;
    this.name = 'minimax'; this.model = 'speech-2.8-turbo'; this.contentType = 'audio/mpeg'; this.format = 'mp3'; this.voices = null;
  }

  #authorized() {
    if (!this.budget) throw new ProviderBlockedError('authorization_required', 'TTS requires an explicit budget ledger.');
    this.budget.assertAuthorized('minimax');
    if (!this.apiKey) throw new ProviderBlockedError('minimax_key_missing', 'Configure MINIMAX_API_KEY locally; do not send it in chat.');
  }

  async availableVoices({ signal } = {}) {
    this.#authorized();
    const operation = operationSignal(signal, this.timeoutMs);
    try {
      const payload = await checkedJson(await this.fetchImpl(`${this.baseUrl}/v1/get_voice`, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ voice_type: 'system' }), signal: operation.signal }), 'MiniMax voice catalog');
      if (payload.base_resp?.status_code !== 0 || !Array.isArray(payload.system_voice)) {
        const status = payload.base_resp?.status_code;
        throw new ProviderBlockedError('minimax_catalog_failed', `MiniMax system voice catalog failed${Number.isInteger(status) ? ` (code ${status})` : ''}. Check the configured official region and API key; no regional retry was attempted.`);
      }
      // Only existing system voices: no cloning or first-use generated voice fees.
      this.voices = payload.system_voice.filter(voice => typeof voice.voice_id === 'string').map(voice => ({ ...voice, source: 'system' }));
      return this.voices;
    } finally { operation.dispose(); }
  }

  async *synthesize(text, { voiceId = this.voiceId, emotion = 'neutral', intensity = 0.25, signal } = {}) {
    this.#authorized(); assertText(text);
    const operation = operationSignal(signal, this.timeoutMs);
    let reservation;
    let usage = null;
    try {
      if (!this.voices) await this.availableVoices({ signal: operation.signal });
      if (!voiceId || !this.voices.some(voice => voice.voice_id === voiceId)) throw new ProviderBlockedError('voice_unavailable', 'Selected MiniMax voice was not in this account’s system-voice list.');
      if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1) throw new ProviderBlockedError('invalid_emotion', 'Speech intensity must be between 0 and 1.');
      const mappedEmotion = EMOTIONS[emotion];
      if (!mappedEmotion) throw new ProviderBlockedError('invalid_emotion', 'Unsupported MiniMax emotion.');
      operation.signal.throwIfAborted();
      // Mainland tariff counts a Chinese character twice; doubling all UTF-16
      // units also conservatively reserves for ASCII and supplementary Unicode.
      const characters = text.length * (this.region === 'china' ? 2 : 1);
      reservation = this.budget.reserve({ provider: 'minimax', kind: 'tts', chars: characters, estimatedUsd: characters * TTS_RESERVATION_USD_PER_CHAR.minimax });
      const body = { model: this.model, text, stream: true, stream_options: { exclude_aggregated_audio: true }, voice_setting: { voice_id: voiceId, speed: 1, vol: 1, pitch: 0, emotion: intensity < 0.15 ? 'calm' : mappedEmotion, text_normalization: true }, audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 }, language_boost: 'Chinese' };
      const response = await this.fetchImpl(`${this.baseUrl}/v1/t2a_v2`, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body), signal: operation.signal });
      if (!response.ok) await checkedJson(response, 'MiniMax speech');
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        const payload = await checkedJson(response, 'MiniMax speech');
        const code = payload.base_resp?.status_code;
        throw new ProviderBlockedError('minimax_non_stream_response', `MiniMax returned no audio stream${Number.isInteger(code) ? ` (code ${code})` : ''}.`);
      }
      let completed = false;
      let audioBytes = 0;
      for await (const event of sseJson(response.body, { signal: operation.signal, maxEventBytes: 8 * 1024 * 1024 })) {
        if (event.base_resp?.status_code && event.base_resp.status_code !== 0) throw new ProviderBlockedError('minimax_speech_failed', `MiniMax speech failed (code ${event.base_resp.status_code}).`);
        if (event.extra_info) usage = { billable_characters: event.extra_info.usage_characters ?? null, billed_voices: event.extra_info.usage_voice_count ?? 0, audio_ms: event.extra_info.audio_length ?? null,
          billing_currency: this.region === 'china' ? 'CNY' : 'USD', estimated_cny: this.region === 'china' && Number.isFinite(event.extra_info.usage_characters) ? event.extra_info.usage_characters * 0.0002 : null };
        const hex = event.data?.audio;
        if (hex) {
          if (typeof hex !== 'string' || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) throw new ProviderBlockedError('invalid_audio', 'MiniMax returned invalid hex audio.');
          const audio = Buffer.from(hex, 'hex');
          audioBytes += audio.length;
          if (audioBytes > 8 * 1024 * 1024) throw new ProviderBlockedError('audio_too_large', 'Short speech exceeded the local audio size limit.');
          operation.signal.throwIfAborted();
          yield audio;
        }
        if (event.data?.status === 2) { completed = true; break; }
      }
      operation.signal.throwIfAborted();
      if (!completed || !audioBytes) throw new ProviderBlockedError('minimax_missing_terminal', 'MiniMax audio stream ended without a completed non-empty synthesis.');
      this.budget.finish(reservation, { status: 'completed', usage, actualUsd: this.region === 'global' && Number.isFinite(usage?.billable_characters) && !usage?.billed_voices ? usage.billable_characters * 0.00006 : null });
      reservation = null;
    } catch (error) {
      if (reservation) { this.budget.finish(reservation, { status: operation.signal.aborted ? 'canceled_usage_unknown' : 'failed_usage_unknown', usage }); reservation = null; }
      throw error;
    } finally {
      // Consumer return() also cancels the HTTP body and preserves the spent reservation.
      operation.abort(new DOMException('Speech iterator closed.', 'AbortError'));
      operation.dispose();
      if (reservation) this.budget.finish(reservation, { status: 'canceled_usage_unknown', usage });
    }
  }
}
