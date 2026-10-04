import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { generateCandidates, verifyCandidate, candidateToAdvice } from './rules.mjs';

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** One cancellation signal covers model, TTS, buffered audio and playback lease. */
export class CoachController extends EventEmitter {
  constructor({ voice, model = null, ledger = null, voiceId, now = () => performance.now(),
    candidates = generateCandidates, verify = verifyCandidate, makeAdvice = candidateToAdvice,
    modelStatus = null, maxAudioBytes = 2 * 1024 * 1024 } = {}) {
    super(); Object.assign(this, { voice, model, ledger, voiceId, now, candidates, verify, makeAdvice, modelStatus, maxAudioBytes });
    this.enabled = false; this.muted = true; this.state = null; this.current = null;
    this.spoken = new Set(); this.analyzed = new Set(); this.records = []; this.error = null; this.epoch = 0;
  }
  snapshot() {
    return { enabled: this.enabled, muted: this.muted, generation: this.epoch,
      source_mode: this.state?.source_mode ?? null, state_id: this.state?.state_id ?? null,
      match_id: this.state?.match_id ?? null, phase: this.state?.phase ?? null,
      advice: this.current?.advice ?? null, status: this.current?.phase ?? 'quiet',
      error: this.error, voice_ready: Boolean(this.voice && this.voiceId),
      model: this.modelStatus ?? (this.model ? `${this.model.provider ?? 'configured'} / ${this.model.model ?? 'selected model'}` : 'no model channel'),
      model_usage: this.modelLedger?.summary?.() ?? null,
      usage: this.ledger?.summary?.() ?? null,
      timing: this.records.slice(-30) };
  }
  publish(type, value = {}) { this.emit('event', { type, at: this.now(), ...value }); }
  start() { this.enabled = true; this.muted = false; this.error = null; this.publish('status', this.snapshot()); }
  mute() { this.muted = true; this.cancel('user_mute'); this.publish('status', this.snapshot()); }
  unmute() { this.muted = false; this.publish('status', this.snapshot()); }
  stop() { this.enabled = false; this.muted = true; this.cancel('session_stopped'); this.state = null; this.spoken.clear(); this.analyzed.clear(); this.publish('status', this.snapshot()); }
  reset(reason = 'source_reset') { this.cancel(reason); this.state = null; this.spoken.clear(); this.analyzed.clear(); this.publish('status', this.snapshot()); }
  cancel(reason) {
    const current = this.current; this.epoch++;
    if (current) { current.controller.abort(reason); current.audio = null;
      current.record.cancelled_at = this.now(); current.record.cancel_reason = reason;
      this.publish('cancel', { advice_id: current.advice?.advice_id, generation: this.epoch, reason }); }
    this.current = null;
  }
  valid(current) {
    if (!current || current !== this.current || current.controller.signal.aborted || !this.enabled || this.muted || !this.state) return false;
    const origin = current.origin;
    if (['session_id','match_id','game_id'].some(key => origin[key] !== this.state[key]) || this.state.terminal) return false;
    return current.candidate ? this.verify(current.candidate, this.state).valid :
      current.options.some(option => this.verify(option, this.state).valid);
  }
  observe(state) {
    const previous = this.state;
    if (previous && (['session_id','match_id','game_id'].some(key => previous[key] !== state[key]) || state.seq < previous.seq)) {
      this.cancel('new_game_or_seek'); this.spoken.clear(); this.analyzed.clear();
    }
    this.state = state;
    if (state.terminal || state.coverage?.state_complete === false) { this.cancel(state.terminal ? 'game_ended' : 'state_unknown'); this.publish('status', this.snapshot()); return; }
    if (this.current && !this.valid(this.current)) this.cancel('premise_changed');
    if (!this.enabled || this.muted) return;
    const options = this.candidates(state).filter(candidate => this.verify(candidate, state).valid)
      .sort((a,b) => (b.score ?? 0) - (a.score ?? 0));
    const fresh = options.filter(candidate => !this.spoken.has(this.key(candidate, state)));
    if (this.current && this.current.candidate?.kind === 'explanation' && fresh.some(candidate =>
      candidate.kind === 'tactic' && (candidate.score ?? 0) > (this.current.candidate.score ?? 0))) this.cancel('higher_value_current_tactic');
    if (this.current) return;
    if (!fresh.length) return;
    // No unbounded polling: a certified opportunity is the only trigger.
    const analysisKey = fingerprint(fresh.map(candidate => this.key(candidate, state)));
    if (this.analyzed.has(analysisKey)) return;
    this.analyzed.add(analysisKey);
    if (this.analyzed.size > 1000) this.analyzed.delete(this.analyzed.values().next().value);
    void this.generate(state, fresh);
  }
  key(candidate, state) { return fingerprint({ session: state.session_id, match: state.match_id, game: state.game_id,
    turn: state.turn, action: candidate.action_id, facts: candidate.immutable_facts, speech: candidate.speech_core }); }
  async generate(state, options) {
    const controller = new AbortController(), record = { state_id: state.state_id, seq: state.seq,
      source_event_time: state.source_event_time ?? null, log_visible_at: state.observed_at_monotonic,
      acoustic_first_sound_at: null, critical_instruction_end_at: null, state_stable_at: this.now(), trigger_at: this.now(), source_mode: state.source_mode };
    const current = { controller, origin: state, options, candidate: null, advice: null,
      phase: 'selecting', audio: null, generation: ++this.epoch, record };
    this.error = null; this.current = current; this.records.push(record); if (this.records.length > 200) this.records.shift();
    try {
      let candidate = options[0];
      if (options.length > 1 && this.model) {
        const selected = await this.model.select({ state, candidates: options, signal: controller.signal });
        record.model_completed_at = this.now();
        if (selected.action_id === null) {
          record.selection = { source: selected.provider ?? this.model.provider ?? 'configured_model', model: selected.model ?? this.model.model ?? null, action_id: null, reason: selected.reason ?? null };
          if (this.current === current) { this.cancel('model_selected_silence'); this.publish('status', this.snapshot()); }
          return;
        }
        candidate = options.find(option => option.action_id === selected.action_id);
        if (!candidate) throw new Error('模型没有选择当前核验候选，本次保持安静。');
        record.selection = { source: selected.provider ?? this.model.provider ?? 'configured_model', model: selected.model ?? this.model.model ?? null, action_id: candidate.action_id, reason: selected.reason ?? null };
      } else record.selection = { source: 'local_verified_subset', action_id: candidate.action_id };
      current.candidate = candidate;
      if (!this.valid(current)) { if (this.current === current) this.cancel('selection_expired'); return; }
      record.validated_at = this.now();
      current.advice = { ...this.makeAdvice(candidate, this.state), advice_id: randomUUID() };
      const advice = current.advice;
      this.spoken.add(this.key(candidate, state));
      current.phase = 'synthesizing'; this.publish('advice', { advice, generation: current.generation });
      if (!this.voice || !this.voiceId) {
        current.phase = 'voice_blocked';
        this.error = '真实语音阻塞：未配置已授权的供应商账户与现成音色。字幕不算语音验收。';
        record.error = this.error; this.publish('status', this.snapshot()); return;
      }
      const chunks = []; let bytes = 0;
      const text = [advice.speech_core, advice.speech_followup].filter(Boolean).join(' ');
      for await (const chunk of this.voice.synthesize(text, { voiceId: this.voiceId,
        emotion: advice.emotion, intensity: advice.intensity, signal: controller.signal })) {
        if (!this.valid(current)) { if (this.current === current) this.cancel('tts_expired'); return; }
        if (record.tts_first_packet_at == null) record.tts_first_packet_at = this.now();
        bytes += chunk.byteLength;
        if (bytes > this.maxAudioBytes) throw new Error('语音超出本地缓冲上限，已停止。');
        chunks.push(Buffer.from(chunk));
      }
      if (!this.valid(current)) { if (this.current === current) this.cancel('audio_expired'); return; }
      if (!bytes) throw new Error('供应商未返回音频，不能标记语音已完成。');
      current.audio = Buffer.concat(chunks); record.tts_completed_at = this.now();
      current.phase = 'ready';
      this.publish('audio', { advice_id: advice.advice_id, generation: current.generation,
        url: `/api/live-coach/audio/${advice.advice_id}`, content_type: 'audio/mpeg', subtitle: advice.subtitle });
    } catch (error) {
      if (controller.signal.aborted || current !== this.current) return;
      this.error = error?.name === 'AbortError' ? null : String(error.message ?? '语音或模型请求失败。');
      record.error = this.error; this.cancel('provider_failed'); this.publish('status', this.snapshot());
    }
  }
  audio(adviceId) { const current = this.current; return this.valid(current) && current.advice?.advice_id === adviceId ? current.audio : null; }
  acknowledge({ advice_id, generation, event, client_time, error_stage, error_name }) {
    const current = this.current;
    if (!this.valid(current) || current.advice?.advice_id !== advice_id || current.generation !== generation) return false;
    if (!['first_sound','ended','playback_error','cancelled'].includes(event)) return false;
    current.record[`client_${event}_time`] = Number.isFinite(client_time) ? client_time : null;
    current.record.audio_measurement_source = 'web_audio_schedule_not_acoustic_measurement';
    current.record[`server_${event}_ack_at`] = this.now();
    if (event === 'playback_error') {
      const stage = ['fetch', 'decode', 'start'].includes(error_stage) ? error_stage : 'unknown';
      current.record.playback_error_stage = stage;
      current.record.playback_error_name = ['HTTPError', 'EmptyAudioBufferError', 'AudioTypeError', 'InvalidAudioBufferError', 'AbortError', 'EncodingError', 'NotSupportedError', 'NotAllowedError', 'InvalidStateError', 'TypeError', 'NetworkError', 'UnknownError', 'Error'].includes(error_name) ? error_name : 'unknown';
      this.error = `浏览器语音${{ fetch: '读取', decode: '解码', start: '播放', unknown: '播放' }[stage]}失败，已静音。尚未完成真实声音验收。`;
      this.mute(); return true;
    }
    if (event === 'first_sound') current.phase = 'playing';
    if (event === 'ended') { current.audio = null; this.current = null; }
    this.publish('status', this.snapshot()); return true;
  }
}
