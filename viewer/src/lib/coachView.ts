export type CoachView = { match_id: string; game_number: number; anchor: string; boundary: string };
type Snapshot = { generation?: number };
type Transport<T extends Snapshot> = (action: 'invalidate' | 'observe', value: unknown) => Promise<T>;
type AdviceEvent = { generation?: number; advice?: { advice_id?: string; match_id?: string; game_id?: string | number } };
type AudioEvent = { generation?: number; advice_id?: string };
const sameView = (a: CoachView | null, b: CoachView | null) => a === b || Boolean(a && b &&
  a.match_id === b.match_id && a.game_number === b.game_number && a.anchor === b.anchor && a.boundary === b.boundary);
const backwards = (a: CoachView, b: CoachView) => {
  const old = a.anchor.match(/^T(\d+)-A(\d+)$/)?.slice(1).map(Number);
  const next = b.anchor.match(/^T(\d+)-A(\d+)$/)?.slice(1).map(Number);
  return Boolean(old && next && (next[0] < old[0] || (next[0] === old[0] &&
    (next[1] < old[1] || (next[1] === old[1] && a.boundary === 'after' && b.boundary === 'before')))));
};

/** A replay change closes the event gate before its asynchronous server reset starts. */
export class CoachViewGuard<T extends Snapshot> {
  private view: CoachView | null = null;
  private revision = 0;
  private seq: number;
  private floor = 0;
  private resetRequired = true;
  private pending: Promise<T> | null = null;
  private accepted: { id: string; generation: number } | null = null;
  private transport: Transport<T>;
  private mode: 'replay' | 'live' = 'replay';
  constructor(transport: Transport<T>, initialSeq = Date.now()) { this.transport = transport; this.seq = initialSeq; }
  get ready() { return !this.pending && (this.mode === 'live' || Boolean(this.view && !this.resetRequired)); }
  get needsInvalidation() { return this.resetRequired; }
  get invalidating() { return Boolean(this.pending); }
  setMode(mode: 'replay' | 'live') {
    if (mode !== this.mode) { this.mode = mode; this.resetRequired = mode === 'replay'; this.forgetAdvice(); }
  }
  setView(next: CoachView | null) {
    if (sameView(this.view, next)) return false;
    const old = this.view;
    const reset = this.mode === 'replay' && (!next || Boolean(old && (old.match_id !== next.match_id || old.game_number !== next.game_number || backwards(old, next))));
    this.view = next; this.revision++;
    if (reset) { this.resetRequired = true; this.forgetAdvice(); }
    return reset;
  }
  forgetAdvice() { this.accepted = null; }
  acceptGeneration(generation: unknown) {
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < this.floor) return false;
    this.floor = generation;
    if (this.accepted && this.accepted.generation < generation) this.forgetAdvice();
    return true;
  }
  invalidate() {
    if (this.pending) return this.pending;
    this.resetRequired = true; this.forgetAdvice();
    const pending = this.transport('invalidate', { view_seq: ++this.seq }).then(snapshot => {
      // A newer SSE generation can arrive before this response; the floor never moves backwards.
      if (typeof snapshot.generation !== 'number' || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0) {
        throw new Error('教练未确认旧回放已失效，语音已停止。');
      }
      this.acceptGeneration(Math.max(this.floor, snapshot.generation));
      this.resetRequired = false;
      return snapshot;
    }).finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }
  async observe(canObserve = () => true) {
    const view = this.view, revision = this.revision;
    try {
      if (!canObserve()) return null;
      if (this.pending) await this.pending;
      if (!canObserve() || this.mode !== 'replay' || !view || revision !== this.revision || !this.ready) return null;
      const seq = ++this.seq;
      try {
        const snapshot = await this.transport('observe', { ...view, view_seq: seq });
        return canObserve() && revision === this.revision && seq === this.seq && this.ready && this.acceptGeneration(snapshot.generation) ? snapshot : null;
      } catch (error) {
        if (!canObserve() || revision !== this.revision || seq !== this.seq) return null;
        throw error;
      }
    } catch (error) {
      if (!canObserve() || revision !== this.revision) return null;
      throw error;
    }
  }
  acceptAdvice(event: AdviceEvent) {
    const advice = event.advice;
    if (!this.ready || typeof advice?.advice_id !== 'string' || !advice.advice_id ||
      (this.mode === 'replay' && (advice.match_id !== this.view?.match_id || String(advice.game_id) !== String(this.view?.game_number))) ||
      !this.acceptGeneration(event.generation)) return false;
    this.accepted = { id: advice.advice_id, generation: event.generation! };
    return true;
  }
  acceptAudio(event: AudioEvent) {
    return this.ready && Boolean(this.accepted && event.advice_id === this.accepted.id &&
      event.generation === this.accepted.generation && event.generation! >= this.floor);
  }
}
