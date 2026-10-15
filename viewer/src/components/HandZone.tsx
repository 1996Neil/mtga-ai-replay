// Keep the real card/visibility path and scrollable list; change presentation only.
import { useEffect } from 'react';
import type { CSSProperties } from 'react';
import type { CardInstance } from '../types/game';
import { CardImage } from './CardImage';
import { lightHandFan } from '../lib/combatFocus';
import { useElementSize } from '../hooks/useElementSize';
interface Props { cards: CardInstance[]; faceUp: boolean; count?: number | null; onInspect?: () => void; }
export function HandZone({ cards, faceUp, count, onInspect }: Props) {
  const [scroll, size] = useElementSize<HTMLDivElement>();
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      if (event.deltaY && !event.deltaX && el.scrollWidth > el.clientWidth) {
        event.preventDefault(); el.scrollBy({left:event.deltaY});
      }
    };
    el.addEventListener('wheel', wheel, {passive:false});
    return () => el.removeEventListener('wheel', wheel);
  }, [faceUp, scroll]);
  if (!faceUp) {
    const n = count === null ? null : count ?? cards.length;
    return <button type="button" className="opponent-hand" onClick={onInspect} aria-haspopup="dialog" aria-label={`查看对手手牌：${n ?? '未知'}张，${cards.length}张已展示`}>
      <span>手牌 <b>{n ?? '?'}</b></span>
      <div className="opponent-hand-backs" aria-hidden="true">{Array.from({ length: Math.min(n ?? 0, 7) }, (_, i) => <div key={i} className="card-back" />)}</div>
    </button>;
  }
  const missing = typeof count === 'number' ? Math.max(0, count - cards.length) : 0;
  const fan = lightHandFan(cards.length, size.width);
  const style = { '--card-w': `${fan.cardWidth}px`, '--card-h': `${fan.cardWidth * 1.4}px` } as CSSProperties;
  return <section className="own-hand light-fan-hand" aria-label={`当前回放位置的我的手牌：${count ?? cards.length}张${missing ? `，${missing}张牌面未记录` : ''}`} style={style}>
    <div ref={scroll} className="hand-scroll" tabIndex={0} role="region" aria-label={`手牌列表，共 ${cards.length} 张已记录卡牌，可左右滚动`}>
      {cards.length ? <div className="hand-strip" data-hand-layout="light-fan" style={{width:fan.width}} onKeyDown={event => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.hand-face')];
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault(); event.stopPropagation();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? cards.length - 1 : Math.max(0, Math.min(cards.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
        buttons[next].focus({preventScroll:true});
        scroll.current?.scrollTo({left:Math.max(0,fan.cards[next].x - (size.width - fan.cardWidth) / 2)});
      }}>
        {cards.map((card,index) => <CardImage key={card.instanceId} grpId={card.grpId} card={card} isTapped={card.isTapped}
          className="hand-face" handNumber={index + 1} power={card.power} toughness={card.toughness}
          style={{left:fan.cards[index].x,'--fan-y':`${fan.cards[index].y}px`,'--fan-angle':`${fan.cards[index].angle}deg`,'--fan-order':index + 1} as CSSProperties} />)}
      </div> : <span className="empty-hand-label">{count ? '手牌牌面未记录' : '暂无手牌'}</span>}
    </div>
  </section>;
}
