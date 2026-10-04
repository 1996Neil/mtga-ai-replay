// Contract: https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd
// API reference still contains older v3 wording; the real account catalog must contain v4 Turbo.
import { assertText, checkedJson, operationSignal, ProviderBlockedError } from './common.mjs';
import { TTS_RESERVATION_USD_PER_CHAR } from './budget.mjs';

const EMOTION_TAGS = { neutral: '', calm: '', correction: '', excited: '[excited] ', happy: '[happy] ', disappointed: '[sad] ', sad: '[sad] ', surprised: '[surprised] ' };

function websocketMessages(socket, signal) {
  const queue = [];
  let bytes = 0;
  let ended = false;
  let failure;
  let wake;
  const notify = () => { wake?.(); wake = null; };
  const onOpen = () => notify();
  const onMessage = event => {
    if (signal.aborted || ended) return;
    if (typeof event.data !== 'string') { failure = new ProviderBlockedError('invalid_audio', 'Eleven returned an unexpected non-JSON frame.'); ended = true; notify(); return; }
    bytes += event.data.length;
    if (bytes > 12 * 1024 * 1024 || queue.length >= 512) { failure = new ProviderBlockedError('audio_too_large', 'Eleven speech buffer exceeded its local limit.'); ended = true; socket.close(); notify(); return; }
    queue.push(event.data); notify();
  };
  const onError = () => { failure = new ProviderBlockedError('eleven_connection_failed', 'Eleven dialogue connection failed; no alternate backend was selected.'); ended = true; notify(); };
  const onClose = () => { ended = true; notify(); };
  const onAbort = () => { failure = signal.reason; ended = true; socket.close(); queue.length = 0; notify(); };
  socket.addEventListener('open', onOpen);
  socket.addEventListener('message', onMessage);
  socket.addEventListener('error', onError);
  socket.addEventListener('close', onClose);
  signal.addEventListener('abort', onAbort, { once: true });
  return {
    async opened() {
      while (socket.readyState === 0 && !ended) await new Promise(resolve => { wake = resolve; });
      signal.throwIfAborted();
      if (failure) throw failure;
      if (socket.readyState !== 1) throw new ProviderBlockedError('eleven_connection_closed', 'Eleven dialogue socket closed before opening.');
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        signal.throwIfAborted();
        if (failure) throw failure;
        if (queue.length) {
          const value = queue.shift(); bytes -= value.length;
          let parsed;
          try { parsed = JSON.parse(value); }
          catch { throw new ProviderBlockedError('invalid_provider_json', 'Eleven returned malformed JSON; payload was discarded.'); }
          yield parsed;
        }
        else if (ended) break;
        else await new Promise(resolve => { wake = resolve; });
      }
    },
    close() {
      signal.removeEventListener('abort', onAbort);
      socket.removeEventListener('open', onOpen); socket.removeEventListener('message', onMessage); socket.removeEventListener('error', onError); socket.removeEventListener('close', onClose);
      // An abort while CONNECTING may dispatch error after close(). Keep a no-op listener.
      socket.addEventListener('error', () => {}, { once: true });
      queue.length = 0; bytes = 0; ended = true; socket.close(); notify();
    },
  };
}

export class ElevenVoiceProvider {
  constructor({ apiKey = process.env.ELEVENLABS_API_KEY, budget, voiceId, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, timeoutMs = 15000 } = {}) {
    this.apiKey = apiKey; this.budget = budget; this.voiceId = voiceId; this.fetchImpl = fetchImpl; this.WebSocketImpl = WebSocketImpl; this.timeoutMs = timeoutMs;
    this.name = 'eleven'; this.model = 'eleven_v4_turbo'; this.contentType = 'audio/mpeg'; this.format = 'mp3'; this.voices = null; this.models = null;
  }

  #authorized() {
    if (!this.budget) throw new ProviderBlockedError('authorization_required', 'TTS requires an explicit budget ledger.');
    this.budget.assertAuthorized('eleven');
    if (!this.apiKey) throw new ProviderBlockedError('eleven_key_missing', 'Configure ELEVENLABS_API_KEY locally; do not send it in chat.');
    if (!this.WebSocketImpl) throw new ProviderBlockedError('websocket_unavailable', 'This runtime has no native WebSocket implementation.');
  }

  async availableModels({ signal } = {}) {
    this.#authorized();
    const operation = operationSignal(signal, this.timeoutMs);
    try {
      const models = await checkedJson(await this.fetchImpl('https://api.elevenlabs.io/v1/models', { headers: { 'xi-api-key': this.apiKey }, signal: operation.signal }), 'Eleven model catalog');
      if (!Array.isArray(models)) throw new ProviderBlockedError('invalid_catalog', 'Eleven model catalog did not return an array.');
      this.models = models;
      return models;
    } finally { operation.dispose(); }
  }

  async availableVoices({ signal } = {}) {
    this.#authorized();
    const operation = operationSignal(signal, this.timeoutMs);
    try {
      const voices = [];
      let nextPage;
      const visited = new Set();
      for (let page = 0; page < 10; page++) {
        const url = new URL('https://api.elevenlabs.io/v2/voices');
        url.searchParams.set('page_size', '100');
        url.searchParams.set('category', 'premade');
        if (nextPage) url.searchParams.set('next_page_token', nextPage);
        const payload = await checkedJson(await this.fetchImpl(url.toString(), { headers: { 'xi-api-key': this.apiKey }, signal: operation.signal }), 'Eleven voice catalog');
        if (!Array.isArray(payload.voices)) throw new ProviderBlockedError('invalid_catalog', 'Eleven voice catalog did not return voices.');
        voices.push(...payload.voices.filter(voice => typeof voice.voice_id === 'string' && voice.category === 'premade').map(voice => ({ ...voice, source: 'premade' })));
        if (!payload.has_more) { this.voices = voices; return voices; }
        if (!payload.next_page_token || visited.has(payload.next_page_token)) throw new ProviderBlockedError('invalid_catalog', 'Eleven voice pagination did not advance.');
        nextPage = payload.next_page_token; visited.add(nextPage);
      }
      throw new ProviderBlockedError('catalog_too_large', 'Eleven voice catalog exceeded the bounded page limit.');
    } finally { operation.dispose(); }
  }

  async *synthesize(text, { voiceId = this.voiceId, emotion = 'neutral', intensity = 0.25, signal } = {}) {
    this.#authorized(); assertText(text);
    const operation = operationSignal(signal, this.timeoutMs);
    let reservation;
    let messages;
    let audioBytes = 0;
    try {
      if (!this.models) await this.availableModels({ signal: operation.signal });
      const model = this.models.find(model => model.model_id === this.model);
      if (!model || model.can_do_text_to_speech === false) throw new ProviderBlockedError('model_unavailable', 'Eleven v4 Turbo was absent from the real account catalog; no older model was substituted.');
      if (!this.voices) await this.availableVoices({ signal: operation.signal });
      if (!voiceId || !this.voices.some(voice => voice.voice_id === voiceId)) throw new ProviderBlockedError('voice_unavailable', 'Selected Eleven voice was not in this account’s premade voice list.');
      if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1 || !Object.hasOwn(EMOTION_TAGS, emotion)) throw new ProviderBlockedError('invalid_emotion', 'Unsupported Eleven emotion or intensity.');
      const spokenText = `${intensity < 0.15 ? '' : EMOTION_TAGS[emotion]}${text}`;
      // Include tags in billable character reservation. Catalog multipliers can only increase it.
      const multiplier = Math.max(1, Number(model.model_rates?.character_cost_multiplier) || 1, Number(model.token_cost_factor) || 1);
      operation.signal.throwIfAborted();
      reservation = this.budget.reserve({ provider: 'eleven', kind: 'tts', chars: spokenText.length, estimatedUsd: spokenText.length * TTS_RESERVATION_USD_PER_CHAR.eleven * multiplier });
      const url = new URL('wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input');
      url.searchParams.set('model_id', this.model); url.searchParams.set('output_format', 'mp3_44100_128'); url.searchParams.set('language_code', 'zh');
      const socket = new this.WebSocketImpl(url.toString());
      messages = websocketMessages(socket, operation.signal);
      await messages.opened();
      operation.signal.throwIfAborted();
      socket.send(JSON.stringify({ voices: [voiceId], xi_api_key: this.apiKey }));
      socket.send(JSON.stringify({ inputs: [{ text: spokenText, voice_id: voiceId, new_turn: true }] }));
      socket.send(JSON.stringify({ flush: true })); // Short Chinese advice often falls below the fixed server threshold.
      socket.send(JSON.stringify({ close_socket: true }));
      let completed = false;
      for await (const frame of messages) {
        if (frame.error || frame.error_message || frame.type === 'error') throw new ProviderBlockedError('eleven_speech_failed', 'Eleven dialogue synthesis failed.');
        if (frame.audio) {
          if (typeof frame.audio !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.audio)) throw new ProviderBlockedError('invalid_audio', 'Eleven returned invalid base64 audio.');
          const audio = Buffer.from(frame.audio, 'base64');
          audioBytes += audio.length;
          if (audioBytes > 8 * 1024 * 1024) throw new ProviderBlockedError('audio_too_large', 'Short speech exceeded its local audio limit.');
          operation.signal.throwIfAborted();
          if (audio.length) yield audio;
        }
        if (frame.is_final === true) { completed = true; break; }
      }
      operation.signal.throwIfAborted();
      if (!completed || !audioBytes) throw new ProviderBlockedError('eleven_missing_terminal', 'Eleven stream ended without its final non-empty audio result.');
      // This WebSocket contract has no actual-billing usage field. Preserve conservative cash reservation.
      this.budget.finish(reservation, { status: 'completed_billing_unknown', usage: { requested_characters: spokenText.length, model: this.model }, actualUsd: null });
      reservation = null;
    } catch (error) {
      if (reservation) { this.budget.finish(reservation, { status: operation.signal.aborted ? 'canceled_usage_unknown' : 'failed_usage_unknown' }); reservation = null; }
      throw error;
    } finally {
      messages?.close();
      operation.abort(new DOMException('Speech iterator closed.', 'AbortError')); operation.dispose();
      if (reservation) this.budget.finish(reservation, { status: 'canceled_usage_unknown' });
    }
  }
}
