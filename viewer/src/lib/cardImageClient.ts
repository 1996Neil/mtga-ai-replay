import type { CardMetadata } from '../store/cardCacheStore';
export interface CardLoadIssue { kind: string; stage?: string; status?: number; code?: string; retry_locked?: boolean }
export interface ImageMetadata extends CardMetadata { image_available?: boolean; image_cached?: boolean; retry_after?: number; image_retry_after?: number; scryfall_id?: string; load_error?: CardLoadIssue; image_error?: CardLoadIssue }
export interface ImageState { card?: ImageMetadata; phase: 'idle' | 'loading' | 'ready' | 'waiting' | 'failed'; attempt: number; retryAt: number; refreshImage: boolean; issue?: CardLoadIssue }
const empty: ImageState = { phase: 'idle', attempt: 0, retryAt: 0, refreshImage: false };
interface Entry { state: ImageState; listeners: Set<() => void>; abort?: AbortController; timer?: ReturnType<typeof setTimeout>; generation: number; retries: number; lastManualAt?: number }
/** One request/timer per visible ID; failed work is released and can recover. */
export function createCardImageClient({ fetcher = fetch, now = Date.now, schedule = setTimeout, cancel = clearTimeout,
  onCard = (_id: number, _card: ImageMetadata) => {} } = {}) {
  const entries = new Map<number, Entry>();
  const get = (id: number) => {
    let e = entries.get(id);
    if (!e) { e = { state: empty, listeners: new Set(), generation: 0, retries: 0 }; entries.set(id, e); }
    return e;
  };
  function publish(e: Entry, state: Partial<ImageState>) { e.state = { ...e.state, ...state }; e.listeners.forEach(fn => fn()); }
  function timer(id: number, e: Entry) {
    if (e.timer) cancel(e.timer);
    if (!e.listeners.size) return;
    e.timer = schedule(() => {
      e.timer = undefined;
      if (!e.listeners.size) return;
      if (e.retries < 3) { e.retries++; void load(id, e); }
      else publish(e, { phase: 'failed' });
    }, Math.max(0, e.state.retryAt - now()));
  }
  function wait(id: number, e: Entry, deadline = 0) {
    publish(e, { phase: 'waiting', retryAt: deadline > now() ? deadline : now() + 1500 * 2 ** e.retries });
    timer(id, e);
  }
  async function load(id: number, e: Entry, afterImageError = false, manual = false) {
    if (e.abort || !e.listeners.size) return;
    const abort = new AbortController(), generation = ++e.generation;
    e.abort = abort;
    if (!afterImageError) publish(e, { phase: 'loading', attempt: e.state.attempt + 1 });
    try {
      const response = await fetcher(`/api/cards/${id}${manual ? '?retry=1' : ''}`, { signal: abort.signal });
      if (generation !== e.generation || abort.signal.aborted) return;
      if (!response.ok) {
        const retry = response.headers.get('retry-after');
        const deadline = retry && /^\d+$/.test(retry) ? now() + Number(retry) * 1000 : Date.parse(retry ?? '');
        publish(e, { issue: { kind: response.status === 429 ? 'rate_limited' : 'http', status: response.status,
          retry_locked: response.status === 429 || Number.isFinite(deadline) && deadline > now() } });
        wait(id, e, Number.isFinite(deadline) ? deadline : response.status === 429 ? now() + 60000 : 0);
        return;
      }
      const card = await response.json() as ImageMetadata;
      if (generation !== e.generation || abort.signal.aborted) return;
      onCard(id, card);
      const issue = card.image_error ?? card.load_error;
      publish(e, { card, issue });
      // A metadata refresh failure must not hide an already cached, usable image.
      const deadline = Math.max(card.image_cached ? 0 : card.retry_after ?? 0,
        manual && !card.image_error?.retry_locked ? 0 : card.image_retry_after ?? 0);
      if (afterImageError || deadline > now() || !(card.image_available || card.image_cached)) wait(id, e, deadline);
      else publish(e, { phase: 'ready', retryAt: 0 });
    } catch (error) {
      if (generation === e.generation && !abort.signal.aborted) {
        publish(e, { issue: { kind: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'connection' } });
        wait(id, e);
      }
    } finally { if (generation === e.generation) e.abort = undefined; }
  }
  return {
    snapshot: (id: number) => id > 0 ? get(id).state : empty,
    subscribe(id: number, listener: () => void) {
      if (!(id > 0)) return () => {};
      const e = get(id); e.listeners.add(listener);
      if (e.state.phase === 'waiting') timer(id, e);
      else if (e.state.phase === 'idle' || e.state.phase === 'loading') void load(id, e);
      return () => {
        e.listeners.delete(listener);
        if (!e.listeners.size) {
          e.abort?.abort(); e.abort = undefined; e.generation++;
          if (e.timer) cancel(e.timer); e.timer = undefined;
        }
      };
    },
    imageError(id: number, attempt: number) {
      const e = get(id);
      if (e.state.attempt !== attempt || e.state.phase !== 'ready') return;
      publish(e, { phase: 'waiting', retryAt: 0, refreshImage: true });
      void load(id, e, true);
    },
    imageLoaded(id: number, attempt: number) {
      const e = get(id);
      if (e.state.attempt === attempt && e.state.phase === 'ready') {
        e.retries = 0;
        if (e.state.refreshImage || e.state.issue !== undefined)
          publish(e, { refreshImage: false, issue: undefined });
      }
    },
    retry(id: number) {
      const e = get(id);
      if (!e.listeners.size || now() - (e.lastManualAt ?? -Infinity) < 500) return;
      e.lastManualAt = now();
      if (e.timer) { cancel(e.timer); e.timer = undefined; }
      // Cancel this observer, not the shared server download. The server
      // coalesces concurrent requests for the same card.
      e.abort?.abort(); e.abort = undefined; e.generation++;
      e.retries = 0;
      publish(e, { retryAt: 0, refreshImage: true });
      void load(id, e, false, true);
    },
  };
}
