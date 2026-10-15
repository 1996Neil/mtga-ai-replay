// Retain the existing card interaction/privacy path; P1 adds no fan transforms.
import { useRef } from 'react';
import type { CSSProperties } from 'react';
import type { CardInstance } from '../types/game';
import { CardImage } from './CardImage';
import { handFanLayout } from '../lib/cardPresentation';
interface Props { cards: CardInstance[]; faceUp: boolean; count?: number | null; }
export function HandZone({ cards, faceUp, count }: Props) {
  const scroll = useRef<HTMLDivElement>(null);
  if (!faceUp) {
    const n = count === null ? null : count ?? cards.length;
    return <div className="opponent-hand" aria-label={`对手手牌：${n ?? '未知'}张；牌面隐藏`}>
      <span>手牌 <b>{n ?? '?'}</b></span>
      <div className="opponent-hand-backs" aria-hidden="true">{Array.from({ length: Math.min(n ?? 0, 7) }, (_, i) => <div key={i} className="card-back" />)}</div>
    </div>;
  }
  const missing = typeof count === 'number' ? Math.max(0, count - cards.length) : 0;
  const fan = handFanLayout(cards.length, 0, { overlap: false, cardWidth: 104 });
  const style = { '--card-w': `${fan.cardWidth}px`, '--card-h': `${fan.cardWidth * 1.4}px`, '--hand-gap': `${fan.stride - fan.cardWidth}px` } as CSSProperties;
  return <section className="own-hand" aria-label="当前回放位置的我的手牌" style={style}>
    <div className="hand-heading"><span>我的手牌 <b>{count ?? cards.length}</b>{missing > 0 && <span> · {missing}张牌面未记录</span>}</span>
      <div className="hand-scroll-controls"><button type="button" aria-label="向左查看手牌" disabled={!cards.length} onClick={() => scroll.current?.scrollBy({ left: -fan.stride * 2 })}>‹</button>
        <button type="button" aria-label="向右查看手牌" disabled={!cards.length} onClick={() => scroll.current?.scrollBy({ left: fan.stride * 2 })}>›</button></div>
    </div>
    <div ref={scroll} className="hand-scroll" tabIndex={0} role="region" aria-label={`手牌列表，共 ${cards.length} 张已记录卡牌，可左右滚动`}>
      {cards.length ? <div className="hand-strip" data-hand-layout="row">
        {cards.map(card => <CardImage key={card.instanceId} grpId={card.grpId} card={card} isTapped={card.isTapped}
          className="hand-face" power={card.power} toughness={card.toughness} />)}
      </div> : <span className="empty-hand-label">{count ? '手牌牌面未记录' : '暂无手牌'}</span>}
    </div>
  </section>;
}
