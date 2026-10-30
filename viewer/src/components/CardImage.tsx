// Adapted from m1kk3l/mtg-replay-viewer CardImage and CardPreviewPane.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';
import { useCardImage } from '../hooks/useCardImage';
import { useElementSize } from '../hooks/useElementSize';
import { useHoverStore } from '../store/hoverStore';
import { visibleCardId } from '../lib/cardPresentation';
import type { CardInstance } from '../types/game';
import { useCombatFocusStore } from '../store/combatFocusStore';

interface Props {
  grpId: number; card?: CardInstance; className?: string; style?: CSSProperties; isTapped?: boolean;
  isAttacking?: boolean; showTooltip?: boolean; showCaption?: boolean; fallbackLabel?: string;
  isToken?: boolean; power?: number; toughness?: number; handNumber?: number;
}

export function ManaCost({ cost }: { cost?: string }) {
  if (!cost) return null;
  const symbols = cost.match(/\{[^}]+\}/g);
  return <span className="mana-cost" aria-label={`法术力费用 ${cost}`}>
    {symbols?.length ? symbols.map((symbol, i) => {
      const value = symbol.slice(1, -1);
      return <span key={i} className={`mana-symbol mana-${value.replace(/[^A-Z0-9]/g, '')}`} title={symbol}>{value}</span>;
    }) : cost}
  </span>;
}

export function CardImage({ grpId, card, className = '', style, isTapped = false, isAttacking = false, showTooltip = true, showCaption = true, fallbackLabel, isToken = false, power, toughness, handNumber }: Props) {
  const visibleId = visibleCardId(grpId, card);
  const hidden = visibleId === 0 && /hidden|post.?game/i.test(card?.visibility ?? '');
  const info = useCardImage(visibleId);
  const [viewport, size] = useElementSize<HTMLDivElement>();
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const togglePinned = useHoverStore(s => s.togglePinned), selected = useHoverStore(s => s.card), pinned = useHoverStore(s => s.pinned);
  useEffect(() => { setLoaded(false); }, [visibleId, info.imageAttempt]);
  useEffect(() => {
    setSlow(false);
    if (!visibleId || loaded) return;
    const timer = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(timer);
  }, [visibleId, info.imageAttempt, loaded]);
  useEffect(() => {
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener('online', changed); window.addEventListener('offline', changed);
    return () => { window.removeEventListener('online', changed); window.removeEventListener('offline', changed); };
  }, []);
  const englishName = hidden ? undefined : card?.name ?? info.name;
  const name = hidden ? '未知牌' : info.displayNameZh ?? englishName ?? fallbackLabel ?? '未知牌';
  const manaCost = hidden ? undefined : card?.manaCost ?? info.manaCost;
  const p = hidden ? undefined : power ?? card?.power ?? info.power;
  const t = hidden ? undefined : toughness ?? card?.toughness ?? info.toughness;
  const pt = p !== undefined || t !== undefined ? `${p ?? '?'}/${t ?? '?'}` : undefined;
  const previewCard: CardInstance = card ?? { instanceId: 0, grpId: visibleId, name: englishName, zoneId: 0, ownerSeatId: 0, controllerSeatId: 0,
    cardTypes: [], isTapped, isAttacking, counters: {}, power, toughness };
  const isSelected = Boolean(showTooltip && pinned && selected && selected.instanceId === previewCard.instanceId && selected.grpId === previewCard.grpId);
  // For a landscape viewport the art is normal card size, simply turned sideways.
  // The board reserves this viewport; there is no extra post-rotation scale factor.
  const turnedWidth = Math.min(size.height, size.width * 5 / 7);
  const artStyle: CSSProperties | undefined = isTapped && turnedWidth > 0 ? {
    position: 'absolute', width: turnedWidth, height: turnedWidth * 7 / 5,
    left: '50%', top: '50%', transform: 'translate(-50%, -50%) rotate(90deg)',
  } : undefined;
  const content = <>
    <div ref={viewport} className="card-art-viewport">
      <div className={`card-art ${isTapped ? 'tapped' : ''}`} style={artStyle}>
        <div className={`card-fallback ${loaded && Boolean(info.imageUrl) ? 'invisible' : ''}`} aria-hidden={loaded && Boolean(info.imageUrl)}>
          <span className="card-fallback-type">{hidden ? '牌面隐藏' : isToken ? '衍生物' : card?.typeLine ?? info.typeLine ?? '卡牌'}</span>
          <strong>{name}</strong><ManaCost cost={manaCost} />{pt && <b>{pt}</b>}
        </div>
        {info.imageUrl && <img key={`${visibleId}:${info.imageAttempt}`} src={info.imageUrl} alt={name} className={loaded ? 'loaded' : ''} loading="lazy" onLoad={() => { setLoaded(true); info.imageLoaded(); }} onError={() => { setLoaded(false); info.imageError(); }} draggable={false} />}
      </div>
      {handNumber !== undefined && <span className="hand-number" aria-hidden="true">{handNumber}</span>}
    </div>
    {showCaption && <div className="card-caption card-readout"><span className="card-name" title={name}>{name}</span>
      {pt && <b className="card-pt" title={`当前力量／防御力 ${pt}`} aria-label={`当前力量／防御力 ${pt}`}>{pt}</b>}
    </div>}
  </>;
  const classes = `card-image ${isTapped ? 'is-tapped' : ''} ${isAttacking ? 'attacking' : ''} ${isSelected ? 'inspected' : ''} ${className}`;
  const title = [name, englishName && englishName !== name ? englishName : '', isTapped ? '已横置' : '', pt].filter(Boolean).join(' · ');
  const recovery = visibleId > 0 && !loaded && (slow || info.imagePhase === 'waiting' || info.imagePhase === 'failed');
  const issueText = !online ? '设备报告离线' : ({
    timeout: '图片请求超时', connection: '连接图片服务失败', rate_limited: '图片服务限流',
    not_found: '未找到对应卡图', identity_mismatch: '版本暂未匹配',
    invalid_image: '图片响应无法显示', http: '图片服务暂时异常',
  } as Record<string, string>)[info.imageIssue?.kind ?? ''] ?? (info.imagePhase === 'failed' ? '图片尚未加载' : '加载较慢');
  return <div className={classes} style={style} data-card-id={visibleId || undefined} data-card-instance={card?.instanceId} data-card-logical={card?.logicalId} title={title}
    onMouseEnter={event => useCombatFocusStore.getState().set(card && event.currentTarget.closest('.full-battlefield:not(.full-land-field)') ? card.instanceId : null)}
    onMouseLeave={() => useCombatFocusStore.getState().clear(card?.instanceId)}
    onBlur={() => useCombatFocusStore.getState().clear(card?.instanceId)}>
    {content}
    {showTooltip && <button type="button" className="card-image-open" aria-label={title} aria-haspopup="dialog" aria-expanded={isSelected}
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) useCombatFocusStore.getState().set(card && event.currentTarget.closest('.full-battlefield:not(.full-land-field)') ? card.instanceId : null); }}
      onClick={() => togglePinned(previewCard)} />}
    {recovery && <div className="card-image-recovery">
      <span className="card-image-issue" role="status" aria-live="polite">{issueText}</span>
      <button type="button" className="card-image-retry" onClick={event => { event.stopPropagation(); info.retryImage(); }}
        title={info.imageIssue?.retry_locked ? '重新检查状态；服务端限流期间会保留等待时间。' : '立即重试这张卡图，无需刷新页面。'}
        aria-label={`重新加载 ${name} 的图片`}>重新加载</button>
    </div>}
  </div>;
}

/** One face-only modal. Background clicks and Escape close only this preview. */
export function CardInspectorOverlay() {
  const card = useHoverStore(s => s.card), close = useHoverStore(s => s.close);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (card && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [card]);
  if (!card) return null;
  return createPortal(<dialog ref={dialog} className="card-inspector-overlay pinned face-only-dialog" aria-label="卡牌预览"
    onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }} onClick={event => { event.stopPropagation(); close(); }}>
    <div className="preview-dismiss">
      <CardImage grpId={card.grpId} card={card} className="inspector-card" showTooltip={false} showCaption={false} />
    </div>
  </dialog>, document.body);
}

export const CardPreviewPane = CardInspectorOverlay;
