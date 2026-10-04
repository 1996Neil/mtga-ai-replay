import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CoachAudioSink } from '../lib/coachAudio';
import { CoachViewGuard } from '../lib/coachView';
import type { CoachView } from '../lib/coachView';
import { LiveCoachSetup } from './LiveCoachSetup';
import './LiveCoachPopover.css';

type PopoverBounds = { left: number; top: number; width: number; maxHeight: number };
type Status = { generation?: number; enabled?: boolean; muted?: boolean; voice_ready?: boolean; error?: string | null; status?: string;
  source_mode?: string; model?: string; usage?: Record<string, unknown> | null; model_usage?: Record<string, unknown> | null; advice?: { subtitle?: string; speech_core?: string } | null };
const post = async (action: string, value: unknown = {}) => {
  const response = await fetch(`/api/live-coach/${action}`, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-MTGA-Coach-Action': 'session' }, body: JSON.stringify(value) });
  if (!response.ok) throw new Error('教练动作未完成，请查看本机配置与服务状态。');
  return await response.json() as Status;
};

export function LiveCoachPanel({ view }: { view: CoachView | null }) {
  const [available, setAvailable] = useState(false), [status, setStatus] = useState<Status>({}), [subtitle, setSubtitle] = useState('');
  const [setupOpen, setSetupOpen] = useState(false), [setupSaving, setSetupSaving] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [sourceMode, setSourceMode] = useState<'replay' | 'live' | null>(null);
  const [panelBounds, setPanelBounds] = useState<PopoverBounds | null>(null);
  const toolbar = useRef<HTMLDivElement>(null), entry = useRef<HTMLButtonElement>(null), panel = useRef<HTMLElement>(null);
  const sink = useRef<CoachAudioSink | null>(null);
  const views = useRef<CoachViewGuard<Status> | null>(null);
  views.current ??= new CoachViewGuard<Status>(post);
  const intent = useRef({ epoch: 0, mode: 'mute' as 'enable' | 'mute' | 'stop' });
  const applyStatus = (next: Status) => setStatus(intent.current.mode === 'enable' ? next : { ...next, muted: true, ...(intent.current.mode === 'stop' ? { enabled: false } : {}) });
  useEffect(() => {
    const abort = new AbortController(); let events: EventSource | null = null, modeKnown = false;
    const audio = new CoachAudioSink(value => { void post('playback', value).catch(() => {}); }); sink.current = audio;
    fetch('/api/health', { signal: abort.signal }).then(response => response.json()).then(health => {
      if (abort.signal.aborted || !health.capabilities?.includes('live-coach')) return;
      setAvailable(true); events = new EventSource('/api/live-coach/events');
      events.onmessage = message => {
        if (abort.signal.aborted) return;
        let event; try { event = JSON.parse(message.data); } catch { return; }
        if (!event || typeof event !== 'object') return;
        const guard = views.current!;
        if (event.type === 'cancel' && guard.acceptGeneration(event.generation)) { guard.forgetAdvice(); audio.stop(); setSubtitle(''); }
        if (event.type === 'status' && guard.acceptGeneration(event.generation)) {
          const firstStatus = !modeKnown && (event.source_mode === 'live' || event.source_mode === 'replay');
          if (firstStatus) { modeKnown = true; guard.setMode(event.source_mode); setSourceMode(event.source_mode); }
          if (guard.ready || firstStatus) {
            applyStatus(event); if (event.muted || !event.enabled) { guard.forgetAdvice(); audio.mute(); setSubtitle(''); }
          }
        }
        if (event.type === 'advice' && intent.current.mode === 'enable' && guard.acceptAdvice(event)) { setSubtitle(event.advice.subtitle || event.advice.speech_core); }
        if (event.type === 'audio' && intent.current.mode === 'enable' && guard.acceptAudio(event)) void audio.play(event);
      };
      events.onerror = () => { if (abort.signal.aborted) return; intent.current = { epoch: intent.current.epoch + 1, mode: 'mute' }; views.current?.forgetAdvice(); audio.mute(); setSubtitle(''); void post('mute').catch(() => {}); setStatus(old => ({ ...old, error: '教练连接中断，语音已停止。', muted: true })); };
    }).catch(() => {});
    return () => { intent.current = { epoch: intent.current.epoch + 1, mode: 'stop' }; abort.abort(); events?.close(); void audio.close(); sink.current = null; };
  }, []);
  useEffect(() => {
    if (!available || !status.enabled || !view || sourceMode !== 'replay' || status.source_mode === 'live' || intent.current.mode !== 'enable') return;
    const epoch = intent.current.epoch;
    void views.current!.observe(() => epoch === intent.current.epoch && intent.current.mode === 'enable').then(next => {
      if (next && epoch === intent.current.epoch) applyStatus(next);
    }).catch(error => {
      if (epoch !== intent.current.epoch) return;
      quiet('mute'); setStatus(old => ({ ...old, error: error.message, muted: true }));
    });
  }, [available, sourceMode, status.enabled, view?.match_id, view?.game_number, view?.anchor, view?.boundary]);
  const quiet = (mode: 'mute' | 'stop') => {
    const epoch = intent.current.epoch + 1; intent.current = { epoch, mode };
    views.current?.forgetAdvice(); sink.current?.mute(); setSubtitle('');
    setStatus(old => ({ ...old, muted: true, ...(mode === 'stop' ? { enabled: false } : {}) }));
    return post(mode).then(next => { if (epoch === intent.current.epoch) applyStatus(next); }).catch(() => {});
  };
  useLayoutEffect(() => {
    const guard = views.current!;
    const reset = guard.setView(view);
    if (sourceMode === 'live') return;
    if (reset || !view) { sink.current?.stop(); setSubtitle(''); }
    if (!available || sourceMode !== 'replay' || !guard.needsInvalidation || guard.invalidating) return;
    const epoch = intent.current.epoch;
    void guard.invalidate().then(next => {
      if (epoch === intent.current.epoch && guard.acceptGeneration(next.generation)) applyStatus(next);
    }).catch(() => {
      if (epoch !== intent.current.epoch || !guard.needsInvalidation) return;
      void quiet('mute'); setStatus(old => ({ ...old, error: '教练未确认旧回放已失效，语音已停止。', muted: true }));
    });
  }, [available, sourceMode, view?.match_id, view?.game_number, view?.anchor, view?.boundary]);
  const mute = () => quiet('mute');
  const dismiss = (restoreFocus = false) => {
    setPanelOpen(false); setSetupOpen(false);
    if (restoreFocus) entry.current?.focus();
  };
  const positionPanel = () => {
    const anchor = entry.current?.getBoundingClientRect();
    if (!anchor) return;
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft || 0, viewportTop = viewport?.offsetTop || 0;
    const viewportWidth = viewport?.width || document.documentElement.clientWidth;
    const viewportHeight = viewport?.height || window.innerHeight;
    const gutter = Math.min(12, viewportWidth / 4, viewportHeight / 4);
    const width = Math.min(680, viewportWidth - 2 * gutter);
    const left = Math.max(viewportLeft + gutter, Math.min(anchor.left, viewportLeft + viewportWidth - width - gutter));
    const minimumHeight = Math.min(100, viewportHeight - 2 * gutter);
    const top = Math.max(viewportTop + gutter, Math.min(anchor.bottom + 8, viewportTop + viewportHeight - gutter - minimumHeight));
    const next = { left, top, width, maxHeight: viewportTop + viewportHeight - top - gutter };
    setPanelBounds(old => old && old.left === next.left && old.top === next.top && old.width === next.width && old.maxHeight === next.maxHeight ? old : next);
  };
  useLayoutEffect(() => {
    if (!panelOpen) return;
    positionPanel();
    const viewport = window.visualViewport;
    const resize = new ResizeObserver(positionPanel);
    if (entry.current) resize.observe(entry.current);
    const header = entry.current?.closest('.app-header');
    if (header) resize.observe(header);
    window.addEventListener('resize', positionPanel);
    window.addEventListener('scroll', positionPanel, true);
    viewport?.addEventListener('resize', positionPanel);
    viewport?.addEventListener('scroll', positionPanel);
    return () => {
      resize.disconnect();
      window.removeEventListener('resize', positionPanel);
      window.removeEventListener('scroll', positionPanel, true);
      viewport?.removeEventListener('resize', positionPanel);
      viewport?.removeEventListener('scroll', positionPanel);
    };
  }, [panelOpen]);
  useEffect(() => {
    if (!panelOpen) return;
    panel.current?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !toolbar.current?.contains(event.target) && !panel.current?.contains(event.target)) dismiss();
    };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [panelOpen]);
  useEffect(() => {
    if (!available) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { void mute(); dismiss(Boolean(panel.current?.contains(document.activeElement))); }
      else if (event.key.toLowerCase() === 'm' && !(event.target instanceof HTMLElement && event.target.matches('input,textarea,select'))) { void mute(); }
    };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  }, [available]);
  if (!available) return null;
  const enable = async () => {
    const wasEnabled = Boolean(status.enabled);
    const epoch = intent.current.epoch + 1; intent.current = { epoch, mode: 'enable' };
    const stillCurrent = () => epoch === intent.current.epoch && intent.current.mode === 'enable';
    try {
      if (!await sink.current?.enable() || !stillCurrent()) return;
      const guard = views.current!;
      if (guard.needsInvalidation) await guard.invalidate();
      if (!stillCurrent() || !guard.ready) return;
      const next = await post(wasEnabled ? 'unmute' : 'start');
      if (!stillCurrent()) {
        if (intent.current.mode !== 'enable') void post(intent.current.mode).catch(() => {});
        return;
      }
      applyStatus(next);
      // First start is observed by the enabled-state effect; unmute does not change that dependency.
      if (wasEnabled && sourceMode !== 'live') {
        const observed = await guard.observe(stillCurrent);
        if (observed && stillCurrent()) applyStatus(observed);
      }
    } catch (error) {
      if (!stillCurrent()) return;
      quiet('mute'); setStatus(old => ({ ...old, error: error instanceof Error ? error.message : '无法启用音频。', muted: true }));
    }
  };
  const compactStatus = status.error ? '需检查' : status.enabled ? (status.muted ? '已静音' : '正在观察') : '未启用';
  return <div className="live-coach-toolbar" ref={toolbar}>
    <button type="button" className="coach-toolbar-button" ref={entry} aria-expanded={panelOpen} aria-controls="live-coach-popover"
      aria-haspopup="dialog" onClick={() => { if (panelOpen) dismiss(); else { positionPanel(); setPanelOpen(true); } }} title={subtitle || status.error || '语音教练与连接设置 · M / Esc 立即静音'}>
      语音教练 <span role="status" aria-live="polite">{compactStatus}</span></button>
    {panelOpen && panelBounds && createPortal(<section id="live-coach-popover" className="live-coach-panel live-coach-popover" style={panelBounds} ref={panel} tabIndex={-1} role="dialog" aria-labelledby="live-coach-title">
    <div className="coach-popover-heading"><strong id="live-coach-title">自动语音教练 · {status.source_mode === 'live' ? '可控练习' : '回放'}</strong>
      <button type="button" onClick={() => dismiss(true)} aria-label="关闭语音教练面板">关闭</button></div>
    <div>
      <button type="button" onClick={() => { void enable(); }} disabled={setupSaving || (!view && sourceMode !== 'live') || (status.enabled && !status.muted)}>{status.enabled ? '恢复声音' : '启用本次会话'}</button>
      <button type="button" onClick={mute}>立即静音 <small>M / Esc</small></button>
      <button type="button" onClick={() => quiet('stop')}>退出教练</button>
      <button type="button" onClick={() => setSetupOpen(open => !open)} aria-expanded={setupOpen} aria-controls="live-coach-setup" disabled={setupSaving}>{setupOpen ? '收起设置' : '语音与连接设置'}</button></div>
    <p role="status" aria-live="polite">{subtitle || (status.enabled ? '正在观察。没有已核验机会时保持安静。' : '启用一次后，随当前回放自动观察与提醒。')}</p>
    {status.error && <p role="alert">{status.error}</p>}
    {status.enabled && !status.voice_ready && !status.error && <p>真实语音尚未配置；此状态不能算语音验收完成。</p>}
    {setupOpen && <div id="live-coach-setup" className="live-coach-setup-container"><LiveCoachSetup onBeforeSave={() => quiet('mute')} onSavingChange={setSetupSaving} /></div>}
    <details><summary>证据与用量</summary><pre>{JSON.stringify({ model: status.model, advice: status.advice, usage: status.usage, model_usage: status.model_usage }, null, 2)}</pre></details>
    </section>, document.body)}
  </div>;
}
