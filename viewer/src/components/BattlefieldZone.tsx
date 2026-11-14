import type { CardInstance } from '../types/game';
import { CardImage } from './CardImage';
import { FullCardRows } from './FullCardRows';
interface Props { cards: CardInstance[]; label?: string; isOpponent?: boolean; isActive?: boolean; highlightIds?: Set<number>; compact?: boolean; lands?: boolean; }
export function PermanentCard({ card, highlighted = false }: { card: CardInstance; highlighted?: boolean }) {
  return <div data-instance={card.instanceId} data-attacking={card.isAttacking || undefined} data-blocking={card.isBlocking || undefined}
    className={`permanent ${card.isTapped ? 'is-tapped' : ''} ${highlighted ? 'current-event-card' : ''}`}>
    <CardImage grpId={card.grpId} card={card} isTapped={card.isTapped} isAttacking={card.isAttacking}
      fallbackLabel="永久物" isToken={card.objectType === 'GameObjectType_Token'} power={card.power} toughness={card.toughness} />
    <div className="permanent-status">
      {card.isAttacking && <span>↑ 攻击</span>}{card.isBlocking && <span>阻挡</span>}
      {card.objectType === 'GameObjectType_Token' && <span>衍生物</span>}
      {card.attachedTo != null && <span title={`结附于 #${card.attachedTo}`}>结附</span>}
      {!!Object.keys(card.counters).length && <span title={Object.entries(card.counters).map(([t,n])=>`${t} ×${n}`).join('、')}>
        {Object.entries(card.counters).map(([t,n])=>`${t.replace('CounterType_', '').replace('P1P1','+1/+1').replace('Charge','充电')} ×${n}`).join('、')}</span>}
      {(card.damage ?? 0) > 0 && <span>已受 {card.damage} 伤害</span>}
    </div>
  </div>;
}
export function BattlefieldZone({ cards, label, isOpponent = false, highlightIds = new Set(), compact = false, lands = false }: Props) {
  return <section className={`battlefield-zone full-battlefield ${isOpponent ? 'opponent-field' : 'local-field'} ${compact ? 'compact-field' : ''} ${lands ? 'full-land-field' : ''}`}
    aria-label={label} data-empty={!cards.length || undefined}>
    {lands && <div className="full-land-heading">{isOpponent ? '对手土地' : '我的土地'} <b>{cards.length}</b></div>}
    <FullCardRows cards={cards} maxCardWidth={lands ? 92 : 118}
      renderCard={card => <PermanentCard key={card.instanceId} card={card} highlighted={highlightIds.has(card.instanceId)} />} />
    {!cards.length && <span className="empty-field">{lands ? '暂无土地' : '暂无非地永久物'}</span>}
  </section>;
}
