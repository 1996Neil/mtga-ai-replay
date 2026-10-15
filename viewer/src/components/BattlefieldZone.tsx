import { useState } from 'react';
import type { CSSProperties } from 'react';
import { landPiles } from '../lib/boardLayout';
import type { CardInstance } from '../types/game';
import { CardImage } from './CardImage';
import { FullCardRows } from './FullCardRows';
import type { CombatMark } from '../lib/combatPresentation';
interface Props { cards: CardInstance[]; label?: string; isOpponent?: boolean; highlightIds?: Set<number>; lands?: boolean; combatMarks?: Map<number, CombatMark>; }
export function PermanentCard({ card, highlighted = false, combat }: { card: CardInstance; highlighted?: boolean; combat?: CombatMark }) {
  return <div data-instance={card.instanceId} data-attacking={combat?.attacking || undefined} data-blocking={combat?.blocking || undefined}
    className={`permanent ${card.isTapped ? 'is-tapped' : ''} ${highlighted ? 'current-event-card' : ''}`}>
    <div className="permanent-face">
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
    </div>
    <div className="permanent-combat" title={combat?.detail} aria-label={combat?.detail}>{combat?.text}</div>
  </div>;
}
export function BattlefieldZone({ cards, label, isOpponent = false, highlightIds = new Set(), lands = false, combatMarks }: Props) {
  return <section className={`battlefield-zone full-battlefield ${isOpponent ? 'opponent-field' : 'local-field'} ${lands ? 'full-land-field' : ''}`}
    aria-label={label} data-empty={!cards.length || undefined}>
    <div className="field-heading"><span>{label} <b>{cards.length}</b></span><span className="field-scroll-hint">可滚动查看</span></div>
    {lands ? <div className="full-card-zone land-stacks" role="region" aria-label={`${label}，共 ${cards.length} 张，同类土地堆叠`}>
      {landPiles(cards).map(pile => <LandStack key={pile[0].instanceId} cards={pile} highlightIds={highlightIds} combatMarks={combatMarks} />)}
    </div> : <FullCardRows cards={cards} label={`${label}，共 ${cards.length} 张，可滚动查看全部`}
      renderCard={card => <PermanentCard key={card.instanceId} card={card} highlighted={highlightIds.has(card.instanceId)} combat={combatMarks?.get(card.instanceId)} />} />}

    {!cards.length && <span className="empty-field">{lands ? '暂无土地' : '暂无非地永久物'}</span>}
  </section>;
}

function LandStack({ cards, highlightIds, combatMarks }: { cards: CardInstance[]; highlightIds: Set<number>; combatMarks?: Map<number, CombatMark> }) {
  const [expanded, setExpanded] = useState(false);
  const first = cards[0], depth = Math.min(cards.length - 1, 3);
  const style = { '--pile-depth': depth, '--pile-face-w': first.isTapped ? 'var(--card-h)' : 'var(--card-w)', '--pile-face-h': first.isTapped ? 'var(--card-w)' : 'var(--card-h)' } as CSSProperties;
  return <div className={`land-stack ${expanded ? 'expanded' : ''}`} style={style} data-land-count={cards.length}>
    <div className="land-stack-cards">
      {cards.map((card, index) => <div key={card.instanceId} className={`land-stack-member ${highlightIds.has(card.instanceId) ? 'highlighted-land' : ''}`}
        style={{ '--pile-offset': Math.min(index, 3), zIndex: highlightIds.has(card.instanceId) ? cards.length + 1 : index } as CSSProperties}>
        <PermanentCard card={card} highlighted={highlightIds.has(card.instanceId)} combat={combatMarks?.get(card.instanceId)} />
      </div>)}
    </div>
    {cards.length > 1 && <button className="land-stack-count" type="button" aria-expanded={expanded}
      aria-label={`${expanded ? '收起' : '展开'} ${first.name || '土地'} ${first.isTapped ? '已横置' : '未横置'} ${cards.length} 张`}
      title={`${cards.length} 张${first.isTapped ? '已横置' : '未横置'}；点击${expanded ? '收起' : '展开'}`}
      onClick={() => setExpanded(value => !value)}>×{cards.length}</button>}
  </div>;
}
