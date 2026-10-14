import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

export function ReplayReviewCoach({ match, currentStepIndex, onJump }: {
  match: Match; currentStepIndex: number; onJump: (anchor: string, boundary: Boundary) => void;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [state, setState] = useState<'loading'|'missing'|'stale'|'ready'|'error'>('loading');
  const [canGenerate, setCanGenerate] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false), [folded, setFolded] = useState(false);
  const [selectedAnchor, setSelectedAnchor] = useState<string | null>(null);
  const [position, setPosition] = useState({ x: -1, y: 130 });
  const [track, setTrack] = useState<Rect | null>(null);
  const drag = useRef<{ pointer: number; startX: number; startY: number; x: number; y: number } | null>(null);
  const epoch = useRef(0), previousStep = useRef<string | null>(null);
  const id = match.matchId, game = match.gameNumber;
  const url = `/api/matches/${encodeURIComponent(id)}/review?game=${game}`;

  useEffect(() => {
    const controller = new AbortController();
    const ticket = ++epoch.current;
    setReview(null); setState('loading'); setCanGenerate(false); setError('');
    setSelectedAnchor(null); setOpen(false); setGenerating(false);
    previousStep.current = null;
    void fetch(url, { cache: 'no-store', signal: controller.signal }).then(async res => {
      if (!res.ok) throw new Error(`复盘服务不可用（${res.status}）。`);
      return await res.json();
    }).then(value => {
      if (controller.signal.aborted || ticket !== epoch.current) return;
      if (value.status === 'ready' && value.review?.match_id === id && value.review.game_number === game) {
        setReview(value.review as Review); setState('ready'); setOpen(true);
      } else setState(value.status === 'stale' ? 'stale' : 'missing');
      setCanGenerate(Boolean(value.can_generate));
    }).catch(err => { if (!controller.signal.aborted && ticket === epoch.current) { setState('error'); setError(String(err.message)); } });
    return () => { controller.abort(); epoch.current++; };
  }, [id, game, url]);

  useEffect(() => {
    const key = `${id}:${game}:${currentStepIndex}`;
    const prev = previousStep.current; previousStep.current = key;
    if (!prev || prev === key || !prev.startsWith(`${id}:${game}:`) || !review) return;
    const anchor = match.steps[currentStepIndex]?.anchor;
    if (anchor && review.notes.some(n => n.anchor === anchor)) {
      setSelectedAnchor(anchor); setOpen(true); setFolded(false);
    }
  }, [id, game, currentStepIndex, review, match.steps]);

  useEffect(() => {
    const resize = () => setPosition(p => ({ x: p.x < 0 ? Math.max(8, window.innerWidth - 410) :
      bounded(p.x, window.innerWidth - 365), y: bounded(p.y, window.innerHeight - 180) }));
    resize(); window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

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
      if (next === slider) return;
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

  const ordered = (review?.notes ?? []).map(note => ({ ...note, index: match.steps.findIndex(s => s.anchor === note.anchor) }))
    .filter(note => note.index >= 0).sort((a, b) => a.index - b.index);
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
  async function generate() {
    if (generating || !canGenerate) return;
    const ticket = epoch.current;
    setGenerating(true); setError('');
    try {
      const response = await fetch(`/api/matches/${encodeURIComponent(id)}/review/generate?game=${game}`, {
        method: 'POST', headers: { 'X-MTGA-Replay-Action': 'review-generate' },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `生成失败（${response.status}）`);
      if (ticket !== epoch.current) return;
      if (result.review?.match_id !== id || result.review?.game_number !== game) throw new Error('服务端返回了不同的对局。');
      setReview(result.review as Review); setState('ready'); setSelectedAnchor(null); setOpen(true);
    } catch (err) { if (ticket === epoch.current) setError(err instanceof Error ? err.message : String(err)); }
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
    setPosition({ x: bounded(d.x + e.clientX - d.startX, window.innerWidth - 365),
      y: bounded(d.y + e.clientY - d.startY, window.innerHeight - 150) });
  }
  function pointerUp(e: ReactPointerEvent<HTMLElement>) {
    if (drag.current?.pointer === e.pointerId) drag.current = null;
  }

  return <>
    <button type="button" className="replay-review-launch" aria-expanded={open}
      aria-controls="replay-review-panel" onClick={() => { setOpen(o => !o); setFolded(false); }}>
      ✦ AI 复盘{review ? ` · ${ordered.length}` : ''}
    </button>
    {open && createPortal(<section id="replay-review-panel" className="replay-review-float" role="dialog" aria-label="AI 比赛复盘"
      style={{ left: position.x, top: position.y }} >
      <header className="replay-review-drag" onPointerDown={pointerDown} onPointerMove={pointerMove}
        onPointerUp={pointerUp} onPointerCancel={pointerUp}>
        <strong>✦ AI 比赛复盘</strong><span className="replay-review-drag-label">拖动标题栏移动</span>
        <button type="button" aria-label={folded ? '展开建议' : '收起建议'} onClick={() => setFolded(v => !v)}>{folded ? '展开' : '收起'}</button>
        <button type="button" aria-label="关闭 AI 复盘" onClick={() => setOpen(false)}>×</button>
      </header>
      {!folded && <div className="replay-review-content">
        {state === 'loading' ? <p role="status">正在读取已保存的复盘…</p> : !review ? <>
          <p>{state === 'stale' ? '回放内容已经更新，原 AI 建议不能再安全定位。请重新分析。' :
            '这场比赛尚无 AI 复盘。只有你主动点击生成，才会请求模型。'}</p>
          {canGenerate ? <button type="button" className="replay-review-generate" disabled={generating} onClick={generate}>
            {generating ? '正在逐节点分析，请勿重复点击…' : '生成本局 AI 复盘（可能产生 API 费用）'}
          </button> : <p>自动生成功能未配置。需要在本机设置独立的复盘模型 API 密钥。</p>}
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
        {error && <p className="replay-review-error" role="alert">{error}</p>}
        {state === 'ready' && <small className="replay-review-footnote">{review?.source} · {review?.created_at?.slice(0, 10)} · AI 建议不是确定的合法行动证明。</small>}
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
