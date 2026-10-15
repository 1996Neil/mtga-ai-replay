import type { CardMetadata } from '../store/cardCacheStore';
export interface ImageMetadata extends CardMetadata { image_available?: boolean; image_cached?: boolean; retry_after?: number; image_retry_after?: number }
export interface ImageState { card?: ImageMetadata; phase: 'idle' | 'loading' | 'ready' | 'waiting' | 'failed'; attempt: number; retryAt: number; refreshImage: boolean }
const empty: ImageState = { phase: 'idle', attempt: 0, retryAt: 0, refreshImage: false };
interface Entry { state: ImageState; listeners: Set<() => void>; abort?: AbortController; timer?: ReturnType<typeof setTimeout>; generation: number; retries: number }
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
      if (e.retries < 2) { e.retries++; void load(id, e); }
      else publish(e, { phase: 'failed' });
    }, Math.max(0, e.state.retryAt - now()));
  }
  function wait(id: number, e: Entry, deadline = 0) {
    publish(e, { phase: 'waiting', retryAt: Math.max(now() + 60_000, deadline) });
    timer(id, e);
  }
  async function load(id: number, e: Entry, afterImageError = false) {
    if (e.abort || !e.listeners.size) return;
    const abort = new AbortController(), generation = ++e.generation;
    e.abort = abort;
    if (!afterImageError) publish(e, { phase: 'loading', attempt: e.state.attempt + 1 });
    try {
      const response = await fetcher(`/api/cards/${id}`, { signal: abort.signal });
      if (!response.ok) throw new Error('Metadata temporarily unavailable');
      const card = await response.json() as ImageMetadata;
      if (generation !== e.generation || abort.signal.aborted) return;
      onCard(id, card);
      publish(e, { card });
      // A metadata refresh failure must not hide an already cached, usable image.
      const deadline = Math.max(card.image_cached ? 0 : card.retry_after ?? 0, card.image_retry_after ?? 0);
      if (afterImageError || deadline > now() || !(card.image_available || card.image_cached)) wait(id, e, deadline);
      else publish(e, { phase: 'ready', retryAt: 0 });
    } catch {
      if (generation === e.generation && !abort.signal.aborted) wait(id, e);
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
      publish(e, { phase: 'waiting', retryAt: now() + 60_000, refreshImage: true });
      void load(id, e, true);
    },
    imageLoaded(id: number, attempt: number) {
      const e = get(id);
      if (e.state.attempt === attempt && e.state.phase === 'ready') {
        e.retries = 0;
        if (e.state.refreshImage) publish(e, { refreshImage: false });
      }
    },
    retry(id: number) {
      const e = get(id);
      if (now() < e.state.retryAt || e.abort || !e.listeners.size) return;
      e.retries = 0; void load(id, e);
    },
  };
}
