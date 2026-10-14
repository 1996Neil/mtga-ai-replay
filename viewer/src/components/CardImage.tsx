// Adapted from m1kk3l/mtg-replay-viewer CardImage and CardPreviewPane.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';
import { useCardImage } from '../hooks/useCardImage';
import { useElementSize } from '../hooks/useElementSize';
import { useHoverStore } from '../store/hoverStore';
import { visibleCardId } from '../lib/cardPresentation';
import type { CardInstance } from '../types/game';

interface Props {
  grpId: number; card?: CardInstance; className?: string; style?: CSSProperties; isTapped?: boolean;
  isAttacking?: boolean; showTooltip?: boolean; showCaption?: boolean; fallbackLabel?: string;
  isToken?: boolean; power?: number; toughness?: number;
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

export function CardImage({ grpId, card, className = '', style, isTapped = false, isAttacking = false, showTooltip = true, showCaption = true, fallbackLabel, isToken = false, power, toughness }: Props) {
  const visibleId = visibleCardId(grpId, card);
  const hidden = visibleId === 0 && /hidden|post.?game/i.test(card?.visibility ?? '');
  const info = useCardImage(visibleId);
  const [viewport, size] = useElementSize<HTMLDivElement>();
  const [imgError, setImgError] = useState(false), [loaded, setLoaded] = useState(false);
  const preview = useHoverStore(s => s.preview), clearPreview = useHoverStore(s => s.clearPreview);
  const togglePinned = useHoverStore(s => s.togglePinned), selected = useHoverStore(s => s.card), pinned = useHoverStore(s => s.pinned);
  useEffect(() => { setImgError(false); setLoaded(false); }, [visibleId]);
  const englishName = hidden ? undefined : card?.name ?? info.name;
  const name = hidden ? '未知牌' : info.displayNameZh ?? englishName ?? fallbackLabel ?? '未知牌';
  const manaCost = hidden ? undefined : card?.manaCost ?? info.manaCost;
  const p = hidden ? undefined : power ?? card?.power ?? info.power;
  const t = hidden ? undefined : toughness ?? card?.toughness ?? info.toughness;
  const pt = p !== undefined || t !== undefined ? `${p ?? '?'}/${t ?? '?'}` : undefined;
  const previewCard: CardInstance = card ?? { instanceId: 0, grpId: visibleId, name: englishName, zoneId: 0, ownerSeatId: 0, controllerSeatId: 0,
    cardTypes: [], isTapped, isAttacking, counters: {}, power, toughness };
  const isSelected = Boolean(pinned && selected && selected.instanceId === previewCard.instanceId && selected.grpId === previewCard.grpId);
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
        <div className={`card-fallback ${loaded && !imgError ? 'invisible' : ''}`} aria-hidden={loaded && !imgError}>
          <span className="card-fallback-type">{hidden ? '牌面隐藏' : isToken ? '衍生物' : card?.typeLine ?? info.typeLine ?? '卡牌'}</span>
          <strong>{name}</strong><ManaCost cost={manaCost} />{pt && <b>{pt}</b>}
        </div>
        {info.imageUrl && !imgError && <img src={info.imageUrl} alt={name} className={loaded ? 'loaded' : ''} loading="lazy" onLoad={() => setLoaded(true)} onError={() => setImgError(true)} draggable={false} />}
      </div>
    </div>
    {showCaption && <div className="card-caption card-readout"><span className="card-name" title={name}>{name}</span>
      {pt && <b className="card-pt" title={`当前力量／防御力 ${pt}`} aria-label={`当前力量／防御力 ${pt}`}>{pt}</b>}
    </div>}
  </>;
  const classes = `card-image ${isTapped ? 'is-tapped' : ''} ${isAttacking ? 'attacking' : ''} ${isSelected ? 'inspected' : ''} ${className}`;
  const title = [name, englishName && englishName !== name ? englishName : '', isTapped ? '已横置' : '', pt].filter(Boolean).join(' · ');
  return showTooltip ? <button type="button" className={classes} style={style} data-card-instance={card?.instanceId} data-card-logical={card?.logicalId} title={title} aria-label={title} aria-haspopup="dialog" aria-expanded={isSelected}
    onMouseEnter={() => preview(previewCard)} onMouseLeave={() => clearPreview(previewCard)}
    onFocus={() => preview(previewCard)} onBlur={() => clearPreview(previewCard)} onClick={() => togglePinned(previewCard)}>{content}</button>
    : <div className={classes} style={style}>{content}</div>;
}

/** The preview contains only the card face. Click the face, click outside, or Escape to dismiss a pinned preview. */
export function CardInspectorOverlay() {
  const card = useHoverStore(s => s.card), pinned = useHoverStore(s => s.pinned), close = useHoverStore(s => s.close);
  useEffect(() => {
    if (!card) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    const onPointer = (event: PointerEvent) => {
      if (pinned && event.target instanceof Element && !event.target.closest('.card-inspector-overlay, .card-image')) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer); };
  }, [card, pinned, close]);
  if (!card) return null;
  return createPortal(<section className={`card-inspector-overlay ${pinned ? 'pinned' : ''}`} role="dialog" aria-modal="false" aria-label="卡牌预览">
    <button type="button" className="preview-dismiss" onClick={close} aria-label="关闭卡牌预览" tabIndex={pinned ? 0 : -1}>
      <CardImage grpId={card.grpId} card={card} className="inspector-card" showTooltip={false} showCaption={false} />
    </button>
  </section>, document.body);
}

export const CardPreviewPane = CardInspectorOverlay;
