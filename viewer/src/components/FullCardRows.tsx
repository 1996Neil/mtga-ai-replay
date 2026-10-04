import type { CSSProperties, ReactNode } from 'react';
import { useElementSize } from '../hooks/useElementSize';
import { fitFullCardRows } from '../lib/fullCardLayout';
import type { CardInstance } from '../types/game';
import { CardImage } from './CardImage';

/** Presentation only: every observed instance keeps its own full card face. */
export function FullCardRows({ cards, className = '', maxCardWidth = 118, renderCard }:
  { cards: CardInstance[]; className?: string; maxCardWidth?: number; renderCard?: (card: CardInstance) => ReactNode }) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const layout = fitFullCardRows(cards.map(card => ({ tapped: card.isTapped })), size.width, size.height,
    { maxCardWidth, gap: 6, captionHeight: 18 });
  // A genuinely tiny measured panel must not silently drop its instances.
  // Normal boards fit without scrolling; impossible fixed-label sizes retain an accessible full-face list.
  const overflow = cards.length > 0 && size.width > 0 && size.height > 0 && layout.cardWidth === 0;
  const cardWidth = overflow ? Math.min(maxCardWidth, size.width / 1.4) : layout.cardWidth;
  const style = { '--card-w': `${cardWidth}px`, '--card-h': `${cardWidth * 1.4}px` } as CSSProperties;
  const render = (card: CardInstance) => renderCard ? renderCard(card) : <CardImage key={card.instanceId} grpId={card.grpId}
    card={card} isTapped={card.isTapped} className="full-row-card" power={card.power} toughness={card.toughness}
    isToken={card.objectType === 'GameObjectType_Token'} />;
  return <div ref={ref} className={`full-card-zone ${className}`}>
    {overflow && <div className="full-card-overflow" style={style} tabIndex={0} role="region" aria-label={`空间不足，${cards.length}张完整卡牌列表，可滚动`}>
      {cards.map(render)}
    </div>}
    {layout.cardWidth > 0 && <div className="full-card-rows" style={style}>
      {layout.rows.map((row, index) => <div key={index} className="full-card-row">
        {row.map(i => render(cards[i]))}
      </div>)}
    </div>}
  </div>;
}
