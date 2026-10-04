type Lease = { advice_id: string; generation: number; url: string };
type ErrorStage = 'fetch' | 'decode' | 'start';
const ERROR_NAMES = ['HTTPError', 'EmptyAudioBufferError', 'AudioTypeError', 'InvalidAudioBufferError', 'AbortError',
  'EncodingError', 'NotSupportedError', 'InvalidStateError', 'NotAllowedError', 'TypeError', 'NetworkError', 'Error', 'UnknownError'] as const;
type ErrorName = typeof ERROR_NAMES[number];
type Ack = (value: { advice_id: string; generation: number; event: string; client_time: number; measurement_source: string;
  error_stage?: ErrorStage; error_name?: ErrorName }) => void;
const audioFailure = (name: ErrorName) => Object.assign(new Error(), { name });
const errorName = (error: unknown): ErrorName => {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
  return typeof name === 'string' && ERROR_NAMES.includes(name as ErrorName) ? name as ErrorName : 'UnknownError';
};

/** Real provider MP3 only. No browser speechSynthesis/mock fallback. */
export class CoachAudioSink {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private fetchController: AbortController | null = null;
  private revision = 0;
  private lease: Lease | null = null;
  private ack: Ack;
  private makeContext: () => AudioContext;
  private fetchAudio: typeof fetch;
  muted = true;
  constructor(ack: Ack, makeContext = () => new AudioContext(), fetchAudio: typeof fetch = (input, init) => fetch(input, init)) {
    // Window.fetch must never receive this sink as its receiver (Illegal invocation in browsers).
    this.ack = ack; this.makeContext = makeContext; this.fetchAudio = (input, init) => fetchAudio(input, init);
  }
  async enable() {
    const revision = ++this.revision;
    this.context ??= this.makeContext(); const context = this.context;
    this.gain ??= context.createGain(); this.gain.gain.value = 0;
    this.gain.connect(context.destination);
    await context.resume();
    if (revision !== this.revision || context !== this.context) return false;
    this.muted = false; this.gain.gain.value = 0.5; return true;
  }
  stop() {
    this.revision++; this.fetchController?.abort(); this.fetchController = null;
    if (this.gain) this.gain.gain.value = 0;
    if (this.source) { this.source.onended = null; try { this.source.stop(); } catch { /* Already stopped. */ } this.source.disconnect(); }
    this.source = null; this.lease = null;
  }
  mute() { this.muted = true; this.stop(); }
  async play(lease: Lease) {
    this.stop(); if (this.muted || !this.context || !this.gain) return;
    this.lease = lease; const revision = this.revision, controller = new AbortController(); this.fetchController = controller;
    const valid = () => !this.muted && revision === this.revision && this.lease === lease && !controller.signal.aborted;
    let stage: ErrorStage = 'fetch';
    try {
      const response = await this.fetchAudio(lease.url, { signal: controller.signal, cache: 'no-store' });
      if (!valid()) return;
      if (!response.ok) throw audioFailure('HTTPError');
      const contentType = response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (contentType && !['audio/mpeg', 'audio/mp3', 'audio/x-mpeg', 'application/octet-stream'].includes(contentType)) throw audioFailure('AudioTypeError');
      const encoded = await response.arrayBuffer(); if (!valid()) return;
      stage = 'decode';
      if (!encoded.byteLength) throw audioFailure('EmptyAudioBufferError');
      const decoded = await this.context.decodeAudioData(encoded); if (!valid()) return;
      if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || !Number.isInteger(decoded.length) || decoded.length <= 0 ||
        !Number.isFinite(decoded.sampleRate) || decoded.sampleRate <= 0 || !Number.isInteger(decoded.numberOfChannels) || decoded.numberOfChannels <= 0) throw audioFailure('InvalidAudioBufferError');
      stage = 'start';
      this.source = this.context.createBufferSource(); this.source.buffer = decoded;
      this.gain.gain.value = 0.5; this.source.connect(this.gain);
      const mark = (event: string) => this.ack({ advice_id: lease.advice_id, generation: lease.generation,
        event, client_time: performance.now(), measurement_source: 'web_audio_schedule_not_acoustic_measurement' });
      this.source.onended = () => { if (valid()) { mark('ended'); this.source = null; this.lease = null; } };
      this.source.start(); mark('first_sound');
    } catch (error) {
      if (!valid()) return;
      const receipt = { advice_id: lease.advice_id, generation: lease.generation, event: 'playback_error',
        client_time: performance.now(), measurement_source: 'browser', error_stage: stage, error_name: errorName(error) };
      this.mute(); this.ack(receipt);
    }
  }
  async close() { this.mute(); await this.context?.close(); this.context = null; this.gain = null; }
}
