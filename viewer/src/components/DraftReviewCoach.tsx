import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { reviewLaunchPresentation } from '../replay/reviewAvailability';
import { draftNotePresentation, draftReviewPickKey } from '../lib/draftReview';
import type { DraftReviewCard, DraftReviewState } from '../lib/draftReview';
import { useCardImage } from '../hooks/useCardImage';
import './ReplayReviewCoach.css';

function CardLabel({ card, onPreview }: { card: DraftReviewCard; onPreview: (card: DraftReviewCard) => void }) {
  const info = useCardImage(card.arena_id);
  return <button type="button" className="draft-review-card" onClick={() => onPreview(card)} aria-haspopup="dialog">
    {info.displayNameZh ?? card.name}
  </button>;
}
function CommentParagraphs({ text }: { text: string }) {
  return <>{text.split(/\n\s*\n/).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</>;
}
export function DraftReviewCoach({ snapshot, currentKey, selectionVersion, onJump, onPreview, onRefresh }: {
  snapshot: DraftReviewState; currentKey: string | undefined; selectionVersion: number;
  onJump: (key: string) => void; onPreview: (card: DraftReviewCard) => void; onRefresh: () => void;
}) {
  const { review, status } = snapshot;
  const [open, setOpen] = useState(false), [folded, setFolded] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [position, setPosition] = useState({ x: -1, y: 130 });
  const [launcher, setLauncher] = useState<HTMLElement | null>(null);
  const panel = useRef<HTMLElement>(null), launchRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ pointer: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const previousKey = useRef(currentKey);
  const previousSelection = useRef(selectionVersion);
  const notes = [...(review?.notes ?? [])].sort((a, b) => a.pack_number - b.pack_number || a.pick_number - b.pick_number);
  const selectedIndex = notes.findIndex(note => draftReviewPickKey(note) === selectedKey);
  const selected = notes[selectedIndex];
  const appearance = selected && draftNotePresentation(selected);
  const launch = reviewLaunchPresentation(status, notes.length);
  const close = () => { setOpen(false); launchRef.current?.focus(); };
  const choose = (key: string) => { onJump(key); setSelectedKey(key); setOpen(true); setFolded(false); };
  const moveComment = (direction: number) => {
    if (!notes.length) return;
    const next = selectedIndex < 0 ? direction > 0 ? 0 : notes.length - 1 :
      (selectedIndex + direction + notes.length) % notes.length;
    choose(draftReviewPickKey(notes[next]));
  };
  function bounded(x: number, y: number) {
    const width = panel.current?.offsetWidth ?? 375, height = panel.current?.offsetHeight ?? 180;
    return { x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - height - 8)) };
  }
  useLayoutEffect(() => { setLauncher(document.getElementById('draft-review-launcher')); }, []);
  useLayoutEffect(() => {
    const clamp = () => setPosition(value => bounded(value.x < 0 ? window.innerWidth - 399 : value.x, value.y));
    clamp();
    const observer = new ResizeObserver(clamp);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', clamp);
    return () => { observer.disconnect(); window.removeEventListener('resize', clamp); };
  }, [open, folded]);
  useEffect(() => {
    if (review) setSelectedKey(null);
  }, [review]);
  useEffect(() => {
    if (previousKey.current === currentKey && previousSelection.current === selectionVersion) return;
    previousKey.current = currentKey;
    previousSelection.current = selectionVersion;
    if (review?.notes.some(note => draftReviewPickKey(note) === currentKey)) {
      setSelectedKey(currentKey ?? null);
    } else setSelectedKey(null);
  }, [currentKey, selectionVersion, review]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) close();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [open]);
  function pointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    drag.current = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, ...position };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: ReactPointerEvent<HTMLElement>) {
    const value = drag.current;
    if (value && value.pointer === event.pointerId)
      setPosition(bounded(value.x + event.clientX - value.startX, value.y + event.clientY - value.startY));
  }
  const button = <button ref={launchRef} type="button" className="sync-button replay-review-launch"
    data-review-status={launch.tone} aria-busy={launch.busy} aria-expanded={open}
    aria-controls="draft-review-panel" aria-keyshortcuts="Space" aria-label={`AI 选牌复盘，${launch.description}`} title={launch.description}
    onClick={() => { setOpen(value => !value); setFolded(false); }}>
    <span aria-hidden="true" className="replay-review-launch-symbol">{launch.symbol}</span><span>{launch.label}</span>
  </button>;
  return <>
    {launcher ? createPortal(button, launcher) : button}
    {open && createPortal(<section ref={panel} id="draft-review-panel" role="dialog" aria-label="AI 选牌复盘"
      className="replay-review-float draft-review-float" style={{ left: position.x, top: position.y }}>
      <header className="replay-review-drag" tabIndex={0} aria-label="移动选牌复盘浮窗：使用方向键"
        onPointerDown={pointerDown} onPointerMove={pointerMove}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        onKeyDown={event => {
          if (event.target !== event.currentTarget) return;
          const direction: Record<string, [number, number]> = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] };
          const delta = direction[event.key]; if (!delta) return;
          event.preventDefault(); event.stopPropagation();
          setPosition(value => bounded(value.x + delta[0], value.y + delta[1]));
        }}>
        <strong>AI 选牌复盘</strong><span className="replay-review-drag-label">拖动标题栏移动</span>
        <button type="button" aria-label={folded ? '展开选牌评论' : '收起选牌评论'} onClick={() => setFolded(value => !value)}>{folded ? '展开' : '收起'}</button>
        <button type="button" aria-label="关闭 AI 选牌复盘" onClick={close}>×</button>
      </header>
      {!folded && <div className="replay-review-content">
        {status === 'loading' ? <p role="status">正在读取选牌复盘…</p> : !review ? <>
          <h3>{status === 'stale' ? '选牌记录已更新' : status === 'error' ? '复盘暂时无法读取' : '这场轮抽暂无 AI 复盘'}</h3>
          <p>{status === 'stale' ? '原评论与当前候选包或选择不一致，已隐藏旧标记。' :
            '有复盘后，可以在这里查看具体抓位的评论。'}</p>
        </> : selected && appearance ? <>
          <div className="replay-review-meta">
            <span className={`severity-text-${appearance.tone}`}>{appearance.symbol} {appearance.judgment}</span>
            <span>第 {selected.pack_number} 包 · 第 {selected.pick_number} 手</span>
          </div>
          <h3>{selected.title}</h3>
          <div className="draft-review-card-comparison">
            <div><span>实际选择</span><CardLabel card={selected.selected} onPreview={onPreview} /></div>
            <div><span>同包比较</span><CardLabel card={selected.alternative} onPreview={onPreview} /></div>
          </div>
          <CommentParagraphs text={selected.suggestion} />
          {selected.rationale.trim() !== selected.suggestion.trim() && <CommentParagraphs text={selected.rationale} />}
          <nav className="replay-review-nav" aria-label="选牌评论导航">
            <button type="button" onClick={() => moveComment(-1)}>← 上一条</button>
            <button type="button" onClick={() => setSelectedKey(null)}>本场总结</button>
            <button type="button" onClick={() => moveComment(1)}>下一条 →</button>
          </nav>
        </> : <>
          <span className="replay-review-eyebrow">本场概览 · {notes.length} 个评论抓位</span>
          <h3>{review.summary.headline}</h3><CommentParagraphs text={review.summary.overview} />
          <p className="replay-review-muted">绿色 ✓ 值得保留 · 蓝色 i 策略建议 · 橙色 ◆ 建议核查</p>
          <nav className="replay-review-nav"><button type="button" disabled={!notes.length} onClick={() => moveComment(1)}>查看第一条评论 →</button></nav>
        </>}
        {snapshot.error && <p className="replay-review-error" role="alert">{snapshot.error}</p>}
        <button type="button" className="draft-review-refresh" disabled={status === 'loading'} onClick={onRefresh}>重新检查复盘</button>
      </div>}
    </section>, document.body)}
  </>;
}
