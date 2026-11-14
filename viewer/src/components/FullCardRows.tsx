import type { ReactNode } from 'react';
import type { CardInstance } from '../types/game';
import { CardImage } from './CardImage';

/** Fixed-size cards with compact spacing; tapped slots reserve their rotated width.
 * Keys stay under one parent so wrapping preserves focus. */
export function FullCardRows({ cards, className = '', label = '全部卡牌，可滚动查看', renderCard }:
  { cards: CardInstance[]; className?: string; label?: string; renderCard?: (card: CardInstance) => ReactNode }) {
  return <div className={`full-card-zone ${className}`} tabIndex={0} role="region" aria-label={label}>
    <div className="full-card-rows">
      {cards.map(card => <div className={`full-card-slot ${card.isTapped ? 'tapped-slot' : ''}`} key={card.instanceId}>
        {renderCard ? renderCard(card) : <CardImage grpId={card.grpId} card={card} isTapped={card.isTapped}
          className="full-row-card" power={card.power} toughness={card.toughness} isToken={card.objectType === 'GameObjectType_Token'} />}
      </div>)}
    </div>
  </div>;
}
