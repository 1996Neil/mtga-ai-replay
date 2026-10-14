import { useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import './ReplayReviewCoach.css';

type Severity = 'critical' | 'major' | 'tip' | 'positive';
type Boundary = 'before' | 'after';
type Note = { anchor: string; boundary: Boundary; severity: Severity; confidence: 'high'|'medium'|'low';
  title: string; observation: string; suggestion: string; rationale?: string; cards: string[]; limitation?: string };
type Review = { schema_version: string; match_id: string; game_number: number; source: string; created_at: string;
  summary: { headline: string; overview: string; strengths: string[]; improvements: string[]; limitations: string[] }; notes: Note[] };
type Match = { matchId: string; gameNumber: number; steps: Array<{ anchor: string }> };
type Rect = { left: number; top: number; width: number; height: number };
const label: Record<Severity, string> = { critical: '重大问题', major: '重要建议', tip: '策略提示', positive: '优秀操作' };
const symbol: Record<Severity, string> = { critical: '!', major: '!', tip: 'i', positive: '✓' };
const severityOrder: Severity[] = ['critical', 'major', 'tip', 'positive'];
const confidence = { high: '较高', medium: '中等', low: '较低' };
const bounded = (value: number, max: number) => Math.max(8, Math.min(Math.max(8, max), value));
const displayDate = (value?: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未知日期';

export function ReplayReviewCoach({ match, currentStepIndex, viewBefore, onJump }: {
  match: Match; currentStepIndex: number; viewBefore: boolean; onJump: (anchor: string, boundary: Boundary) => void;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [state, setState] = useState<'loading'|'missing'|'stale'|'syncing'|'ready'|'error'>('loading');
  const [canSync, setCanSync] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [open, setOpen] = useState(false), [folded, setFolded] = useState(false);
  const [selectedAnchor, setSelectedAnchor] = useState<string | null>(null);
  const [position, setPosition] = useState({ x: -1, y: 130 });
  const [track, setTrack] = useState<Rect | null>(null);
  const drag = useRef<{ pointer: number; startX: number; startY: number; x: number; y: number } | null>(null);
  const [pollVersion, setPollVersion] = useState(0);
  const panel = useRef<HTMLElement | null>(null);
  const epoch = useRef(0), previousStep = useRef<string | null>(null);
  const id = match.matchId, game = match.gameNumber;
  const url = `/api/matches/${encodeURIComponent(id)}/review?game=${game}`;

  useEffect(() => {
    const controller = new AbortController(); const ticket = ++epoch.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setReview(null); setState('loading'); setCanSync(false); setError(''); setCheckedAt(null);
    setSelectedAnchor(null); setGenerating(false); previousStep.current = null;
    async function read() {
      try {
        const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
        if (!res.ok) throw new Error(`复盘服务不可用（${res.status}）。`);
        const value = await res.json();
        if (controller.signal.aborted || ticket !== epoch.current) return;
        setCanSync(Boolean(value.can_sync));
        setCheckedAt(typeof value.checked_at === 'string' ? value.checked_at : null);
        if (value.status === 'ready' && value.review?.match_id === id && value.review.game_number === game) {
          setReview(value.review as Review); setState('ready'); setGenerating(false); setOpen(true); if (value.offline || value.error) setError(value.error ?? '当前离线，显示上次校验的云端复盘。');
        } else if (value.status === 'syncing') {
          setState('syncing'); setGenerating(true);
          timer = setTimeout(() => { void read(); }, 800);
        } else {
          setReview(null); setGenerating(false); setState(value.status === 'stale' ? 'stale' : value.status === 'error' ? 'error' : 'missing');
          if (value.error) setError(value.error);
        }
      } catch (err) {
        if (!controller.signal.aborted && ticket === epoch.current) {
          setState('error'); setError(err instanceof Error ? err.message : String(err));
          // Reconnect to the same read-only sync; never start a model request.
          timer = setTimeout(() => { void read(); }, 2000);
        }
      }
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); epoch.current++; };
  }, [id, game, url, match.steps, pollVersion]);

  useEffect(() => {
    const key = `${id}:${game}:${currentStepIndex}:${viewBefore}`;
    const prev = previousStep.current; previousStep.current = key;
    if (!prev || prev === key || !prev.startsWith(`${id}:${game}:`) || !review) return;
    const anchor = match.steps[currentStepIndex]?.anchor;
    if (anchor && review.notes.some(n => n.anchor === anchor && n.boundary === (viewBefore ? 'before' : 'after'))) {
      setSelectedAnchor(anchor); setOpen(true); setFolded(false);
    } else setSelectedAnchor(null);
  }, [id, game, currentStepIndex, viewBefore, review, match.steps]);

  useLayoutEffect(() => {
    function clamp() {
      const r = panel.current?.getBoundingClientRect();
      setPosition(p => {
        const x = p.x < 0 ? Math.max(8, window.innerWidth - (r?.width ?? 375) - 24) : bounded(p.x, window.innerWidth - (r?.width ?? 375) - 8);
        const y = bounded(p.y, window.innerHeight - (r?.height ?? 180) - 8);
        return p.x === x && p.y === y ? p : { x, y };
      });
    }
    clamp(); const observer = new ResizeObserver(clamp);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', clamp);
    return () => { observer.disconnect(); window.removeEventListener('resize', clamp); };
  }, [open, folded]);

  useLayoutEffect(() => {
    let slider: Element | null = null, observer: ResizeObserver | null = null;
    const footer = document.getElementById('replay-controls');
    const place = () => {
      if (!slider) return;
      const r = slider.getBoundingClientRect();
      setTrack(r.width > 50 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null);
    };
    const find = () => {
      const next = footer?.querySelector('input[type="range"],[role="slider"]') ?? null;
      if (next === slider) { place(); return; }
      observer?.disconnect(); slider = next;
      if (slider) { observer = new ResizeObserver(place); observer.observe(slider); place(); }
      else setTrack(null);
    };
    find();
    const mutation = footer ? new MutationObserver(find) : null;
    if (footer) mutation?.observe(footer, { childList: true, subtree: true });
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { observer?.disconnect(); mutation?.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [id, game]);

  const ordered = useMemo(() => {
    const indices = new Map(match.steps.map((step, i) => [step.anchor, i]));
    return (review?.notes ?? []).map(note => ({ ...note, index: indices.get(note.anchor) ?? -1 }))
      .filter(note => note.index >= 0).sort((a, b) => a.index - b.index);
  }, [review, match.steps]);
  const selected = ordered.find(note => note.anchor === selectedAnchor) ?? null;
  const selectedIndex = selected ? ordered.findIndex(note => note.anchor === selected.anchor) : -1;
  const markers: Array<typeof ordered> = [];
  const width = track ? Math.max(track.width - 16, 1) : 800;
  for (const note of ordered) {
    const last = markers[markers.length - 1];
    const pos = note.index * width / Math.max(match.steps.length - 1, 1);
    const prev = last?.[last.length - 1];
    const prevPos = prev ? prev.index * width / Math.max(match.steps.length - 1, 1) : -100;
    if (last && pos - prevPos < 16) last.push(note);
    else markers.push([note]);
  }
  const choose = (note: Note) => {
    onJump(note.anchor, note.boundary);
    setSelectedAnchor(note.anchor); setOpen(true); setFolded(false);
  };
  const markerButtons = markers.map((group, index) => {
    const first = group[0], winner = group.slice().sort((a, b) =>
      severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity))[0];
    const left = first.index / Math.max(match.steps.length - 1, 1) * 100;
    return <button key={first.anchor + index} type="button"
      className={`replay-review-marker severity-${winner.severity}`}
      style={{ left: `${left}%` }}
      aria-label={`${label[winner.severity]}，${group.length} 条，${first.anchor}，点击定位`}
      title={`${first.anchor} · ${label[winner.severity]} · ${group.length} 条建议`}
      onClick={() => choose(first)}>{group.length > 1 ? group.length : symbol[winner.severity]}</button>;
  });
  const changeSelected = (direction: -1|1) => {
    if (!ordered.length) return;
    const i = selectedIndex < 0 ? (direction > 0 ? 0 : ordered.length - 1) :
      (selectedIndex + direction + ordered.length) % ordered.length;
    choose(ordered[i]);
  };
  async function syncCloudReview() {
    if (generating || !canSync) return;
    const ticket = epoch.current;
    setGenerating(true); setError('');
    try {
      const response = await fetch(`/api/matches/${encodeURIComponent(id)}/review/sync?game=${game}`, {
        method: 'POST', headers: { 'X-MTGA-Replay-Action': 'review-sync' },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `同步失败（${response.status}）`);
      if (ticket !== epoch.current) return;
      setState('syncing');
      setOpen(true); setPollVersion(v => v + 1);
    } catch (err) { if (ticket === epoch.current) { setError(err instanceof Error ? err.message : String(err)); setPollVersion(v => v + 1); } }
    finally { if (ticket === epoch.current) setGenerating(false); }
  }
  function pointerDown(e: ReactPointerEvent<HTMLElement>) {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    drag.current = { pointer: e.pointerId, startX: e.clientX, startY: e.clientY, x: position.x, y: position.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function pointerMove(e: ReactPointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    setPosition({ x: bounded(d.x + e.clientX - d.startX, window.innerWidth - (panel.current?.offsetWidth ?? 375) - 8),
      y: bounded(d.y + e.clientY - d.startY, window.innerHeight - (panel.current?.offsetHeight ?? 180) - 8) });
  }
  function pointerUp(e: ReactPointerEvent<HTMLElement>) {
    if (drag.current?.pointer === e.pointerId) drag.current = null;
  }

  return <>
    <button type="button" className="replay-review-launch" aria-expanded={open}
      aria-controls="replay-review-panel" onClick={() => { setOpen(o => !o); setFolded(false); }}>
      ✦ AI 复盘{review ? ` · ${ordered.length}` : ''}
    </button>
    {open && createPortal(<section ref={panel} id="replay-review-panel" className="replay-review-float" role="dialog" aria-label="AI 比赛复盘"
      style={{ left: position.x, top: position.y }} >
      <header className="replay-review-drag" onPointerDown={pointerDown} onPointerMove={pointerMove}
        onPointerUp={pointerUp} onPointerCancel={pointerUp} tabIndex={0} aria-label="移动复盘浮窗：使用方向键"
        onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === 'Escape') { setOpen(false); return; }
          const direction: Record<string, [number, number]> = { ArrowLeft: [-20,0], ArrowRight: [20,0], ArrowUp: [0,-20], ArrowDown: [0,20] };
          const move = direction[e.key]; if (!move) return; e.preventDefault(); e.stopPropagation();
          setPosition(p => ({ x: bounded(p.x + move[0], window.innerWidth - (panel.current?.offsetWidth ?? 375) - 8),
            y: bounded(p.y + move[1], window.innerHeight - (panel.current?.offsetHeight ?? 180) - 8) })); }}>
        <strong>✦ AI 比赛复盘</strong><span className="replay-review-drag-label">拖动标题栏移动</span>
        <button type="button" aria-label={folded ? '展开建议' : '收起建议'} onClick={() => setFolded(v => !v)}>{folded ? '展开' : '收起'}</button>
        <button type="button" aria-label="关闭 AI 复盘" onClick={() => setOpen(false)}>×</button>
      </header>
      {!folded && <div className="replay-review-content">
        {generating || state === 'syncing' ? <p role="status">正在检查云端复盘…</p> : state === 'loading' ? <p role="status">正在读取已保存的复盘…</p> : !review ? <>
          <p>{state === 'stale' ? '比赛数据或分析政策已经更新，原云端建议不能再安全定位。' :
            '这场比赛尚无已校验的云端 AI 复盘。'}</p>
          <button type="button" className="replay-review-generate" disabled={generating || !canSync} onClick={syncCloudReview}>
            检查/同步云端复盘
          </button>
          {!canSync && <p>云端复盘使用已有私有数据仓库连接；本地无需模型密钥。</p>}
        </> : selected ? <>
          <div className="replay-review-meta"><span className={`severity-text-${selected.severity}`}>
            {symbol[selected.severity]} {label[selected.severity]}</span>
            <span>{selected.anchor} · 动作{selected.boundary === 'before' ? '前' : '后'}</span>
            <span>置信度：{confidence[selected.confidence]}</span></div>
          <h3>{selected.title}</h3>
          {selected.cards.length > 0 && <div className="replay-review-cards">{selected.cards.map(card =>
            <code key={card}>{card}</code>)}</div>}
          <p><b>观察：</b>{selected.observation}</p><p><b>建议：</b>{selected.suggestion}</p>
          {selected.rationale && <p><b>原因：</b>{selected.rationale}</p>}
          {selected.limitation && <p className="replay-review-muted">限制：{selected.limitation}</p>}
          <nav className="replay-review-nav"><button type="button" onClick={() => changeSelected(-1)}>← 上一条</button>
            <button type="button" onClick={() => setSelectedAnchor(null)}>本局总结</button>
            <button type="button" onClick={() => changeSelected(1)}>下一条 →</button></nav>
        </> : <>
          <span className="replay-review-eyebrow">本局概览 · {ordered.length} 个标记</span>
          <h3>{review.summary.headline}</h3>
          <p>{review.summary.overview}</p>
          {review.summary.strengths.length > 0 && <div><b>✓ 值得保留</b><ul>{review.summary.strengths.map((s,i)=><li key={i}>{s}</li>)}</ul></div>}
          {review.summary.improvements.length > 0 && <div><b>↗ 后续重点</b><ul>{review.summary.improvements.map((s,i)=><li key={i}>{s}</li>)}</ul></div>}
          {review.summary.limitations.length > 0 && <details><summary>分析边界</summary><ul>{review.summary.limitations.map((s,i)=><li key={i}>{s}</li>)}</ul></details>}
          <div className="replay-review-legend" aria-label="时间轴标记图例">
            {severityOrder.map(k=><span key={k} className={`severity-text-${k}`}>{symbol[k]} {label[k]}</span>)}
          </div>
          <nav className="replay-review-nav"><button type="button" disabled={!ordered.length} onClick={() => changeSelected(1)}>查看第一条建议 →</button></nav>
        </>}
        {review && <button type="button" disabled={generating || !canSync} onClick={syncCloudReview}>检查/同步云端复盘</button>}
        {error && <p className="replay-review-error" role="alert">{error}</p>}
        {state === 'ready' && <small className="replay-review-footnote">{review?.source} · {displayDate(review?.created_at)}{checkedAt ? ` · 上次校验 ${displayDate(checkedAt)}` : ''} · AI 建议不是确定的合法行动证明。</small>}
      </div>}
    </section>, document.body)}
    {!!markerButtons.length && (track ?
      createPortal(<div className="replay-review-track" role="group" aria-label="AI 建议时间轴标记" style={{
        left: track.left + 8, top: track.top + track.height / 2 - 8, width: Math.max(1, track.width - 16),
      }}>{markerButtons}</div>, document.body)
      : document.getElementById('replay-controls') &&
        createPortal(<div className="replay-review-inline-track" role="group" aria-label="AI 建议时间轴标记">{markerButtons}</div>,
          document.getElementById('replay-controls')!))}
  </>;
}
