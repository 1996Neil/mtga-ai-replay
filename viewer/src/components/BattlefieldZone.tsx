import { useState } from 'react';
import type { CSSProperties } from 'react';
import { landPiles } from '../lib/boardLayout';
import { battlefieldSections } from '../lib/battlefieldSections';
import type { CardInstance } from '../types/game';
import { CardImage } from './CardImage';
import { FullCardRows } from './FullCardRows';
import type { CombatMark } from '../lib/combatPresentation';
interface Props { cards: CardInstance[]; label?: string; isOpponent?: boolean; highlightIds?: Set<number>; lands?: boolean; combatMarks?: Map<number, CombatMark>; focusActive?: boolean; focused?: number | null; related?: ReadonlySet<number>; attachmentGroups?: ReadonlyMap<number, CardInstance[]>; exileGroups?: ReadonlyMap<number, CardInstance[]>; typeLine?: (card: CardInstance) => string | undefined; }
export function PermanentCard({ card, highlighted = false, combat, focusActive = false, focused, related }: { card: CardInstance; highlighted?: boolean; combat?: CombatMark; focusActive?: boolean; focused?: number | null; related?: ReadonlySet<number> }) {
  return <div data-instance={card.instanceId} data-attacking={combat?.attacking || undefined} data-blocking={combat?.blocking || undefined}
    className={`permanent ${card.isTapped ? 'is-tapped' : ''} ${highlighted ? 'current-event-card' : ''} ${focusActive && !related?.has(card.instanceId) ? 'combat-dimmed' : ''} ${focused === card.instanceId ? 'combat-focused' : ''}`}>
    <div className="permanent-face">
    <CardImage grpId={card.grpId} card={card} isTapped={card.isTapped} isAttacking={card.isAttacking}
      fallbackLabel="永久物" isToken={card.objectType === 'GameObjectType_Token'} power={card.power} toughness={card.toughness} />
    <div className="permanent-status">
      {card.isAttacking && <span>{card.attackState === 'AttackState_Declared' ? '待确认攻击' : '↑ 攻击'}</span>}
      {card.isBlocking && <span>{card.blockState === 'BlockState_Declared' ? '待确认阻挡' : '↘ 阻挡'}</span>}
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
export function BattlefieldZone({ cards, label, isOpponent = false, highlightIds = new Set(), lands = false, combatMarks, focusActive, focused, related, attachmentGroups, exileGroups, typeLine }: Props) {
  const shownCount = cards.reduce((count, card) => count + 1 + (attachmentGroups?.get(card.instanceId)?.length ?? 0), 0);
  const pile = (card: CardInstance) => attachmentGroups?.get(card.instanceId) ?? [];
  const hasExile = (card: CardInstance) => !!exileGroups?.get(card.instanceId)?.length || pile(card).some(item => !!exileGroups?.get(item.instanceId)?.length);
  const renderPermanent = (card: CardInstance) => <ExilePile source={card} exiled={exileGroups?.get(card.instanceId) ?? []}><PermanentCard card={card} highlighted={highlightIds.has(card.instanceId)} combat={combatMarks?.get(card.instanceId)} focusActive={focusActive} focused={focused} related={related} /></ExilePile>;
  const renderPile = (card: CardInstance) => <AttachmentPile card={card} attachments={pile(card)} hasExile={hasExile(card)} renderCard={renderPermanent} />;
  const sections = battlefieldSections(cards,typeLine);
  const sideStyle = (items: CardInstance[], maxColumns = 1) => {
    const columns = Math.min(items.length, maxColumns);
    const depth = Math.max(0, ...items.map(card => pile(card).length));
    const wide = items.some(card => card.isTapped || pile(card).some(item => item.isTapped));
    return { width: `calc(var(--card-${wide ? 'h' : 'w'}) * ${columns} + ${depth * 12 + 6 * columns + 10 * (columns - 1)}px)` };
  };
  return <section className={`battlefield-zone full-battlefield ${isOpponent ? 'opponent-field' : 'local-field'} ${lands ? 'full-land-field' : ''}`}
    aria-label={label} data-empty={!cards.length || undefined}>
    <div className="field-heading"><span>{label} <b>{shownCount}</b></span><span className="field-scroll-hint">可滚动查看</span></div>
    {lands ? <div className="full-card-zone land-stacks" role="region" aria-label={`${label}，共 ${cards.length} 张，同类土地堆叠`}>
      {landPiles(cards).flatMap(group => group.some(card => pile(card).length || hasExile(card)) ? group.map(card => [card]) : [group]).map(pile => <LandStack key={pile[0].instanceId} cards={pile} highlightIds={highlightIds} combatMarks={combatMarks} attachmentGroups={attachmentGroups} exileGroups={exileGroups} renderPile={renderPile} />)}
    </div> : <div className="battlefield-content">
      <FullCardRows cards={sections.main} className="creature-card-zone" label={`${label}主区，共 ${sections.main.length} 张主体，可滚动查看全部`}
        slotStyle={card => attachmentSlot(card, pile(card), hasExile(card))} renderCard={renderPile} />
      {!!sections.side.length && <aside className="permanent-side-zone ordinary-permanent-zone" aria-label={`${label}的独立神器和结界`} style={sideStyle(sections.side, 2)}>
        <FullCardRows cards={sections.side} label={`${label}的独立神器和结界`} slotStyle={card => attachmentSlot(card, pile(card), hasExile(card))} renderCard={renderPile} />
      </aside>}
      {!!sections.featured.length && <aside className="permanent-side-zone featured-permanent-zone" aria-label={`${label}的鹏洛客、传纪与战役`} style={sideStyle(sections.featured)}>
        <FullCardRows cards={sections.featured} label={`${label}的鹏洛客、传纪与战役`} slotStyle={card => attachmentSlot(card, pile(card), hasExile(card))} renderCard={renderPile} />
      </aside>}
    </div>}


    {!cards.length && <span className="empty-field">{lands ? '暂无土地' : '暂无非地永久物'}</span>}
  </section>;
}

function LandStack({ cards, highlightIds, attachmentGroups, exileGroups, renderPile }: { cards: CardInstance[]; highlightIds: Set<number>; combatMarks?: Map<number, CombatMark>; attachmentGroups?: ReadonlyMap<number, CardInstance[]>; exileGroups?: ReadonlyMap<number, CardInstance[]>; renderPile: (card: CardInstance) => React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const first = cards[0], depth = Math.min(cards.length - 1, 3), attachmentDepth = Math.max(0, ...cards.map(card => attachmentGroups?.get(card.instanceId)?.length ?? 0));
  const hasExile = (card: CardInstance) => !!exileGroups?.get(card.instanceId)?.length || (attachmentGroups?.get(card.instanceId) ?? []).some(item => !!exileGroups?.get(item.instanceId)?.length);
  const style = { '--exile-extra': cards.some(hasExile) ? 'calc(var(--card-h) * .44 + 4px)' : '0px', '--pile-depth': depth, '--attachment-depth': attachmentDepth, '--pile-face-w': first.isTapped ? 'var(--card-h)' : 'var(--card-w)', '--pile-face-h': first.isTapped ? 'var(--card-w)' : 'var(--card-h)' } as CSSProperties;
  return <div className={`land-stack ${expanded ? 'expanded' : ''}`} style={style} data-land-count={cards.length}>
    <div className="land-stack-cards">
      {cards.map((card, index) => <div key={card.instanceId} className={`land-stack-member ${highlightIds.has(card.instanceId) ? 'highlighted-land' : ''}`}
        style={{ ...(expanded ? attachmentSlot(card, attachmentGroups?.get(card.instanceId) ?? [], hasExile(card)) : {}), '--pile-offset': Math.min(index, 3), zIndex: highlightIds.has(card.instanceId) ? cards.length + 1 : index } as CSSProperties}>
        {renderPile(card)}
      </div>)}
    </div>
    {cards.length > 1 && <button className="land-stack-count" type="button" aria-expanded={expanded}
      aria-label={`${expanded ? '收起' : '展开'} ${first.name || '土地'} ${first.isTapped ? '已横置' : '未横置'} ${cards.length} 张`}
      title={`${cards.length} 张${first.isTapped ? '已横置' : '未横置'}；点击${expanded ? '收起' : '展开'}`}
      onClick={() => setExpanded(value => !value)}>×{cards.length}</button>}
  </div>;
}

function attachmentSlot(card: CardInstance, attachments: CardInstance[], hasExile = false): CSSProperties | undefined {
  if (!attachments.length && !hasExile) return;
  const wide = card.isTapped || attachments.some(item => item.isTapped);
  return { width: `calc(var(--card-${wide ? 'h' : 'w'}) + ${attachments.length * 12}px)`, height: `calc(var(--card-h) + 40px + ${attachments.length * 26}px + ${hasExile ? 'var(--card-h) * .44 + 4px' : '0px'})` };
}
function AttachmentPile({ card, attachments, hasExile, renderCard }: { card: CardInstance; attachments: CardInstance[]; hasExile?: boolean; renderCard: (card: CardInstance) => React.ReactNode }) {
  if (!attachments.length) return renderCard(card);
  return <div className="attachment-pile" data-attachment-host={card.instanceId} style={{ '--attachment-depth': attachments.length, '--exile-extra': hasExile ? 'calc(var(--card-h) * .44 + 4px)' : '0px' } as CSSProperties}>
    {attachments.map((item, index) => <div key={item.instanceId} className="attachment-underlay" style={{ '--attachment-index': index + 1, zIndex: attachments.length - index } as CSSProperties}>{renderCard(item)}</div>)}
    <div className="attachment-host" style={{ zIndex: attachments.length + 1 }}>{renderCard(card)}</div>
  </div>;
}

/** A thumbnail is another view of a currently visible exile object. It stays in
 * the exile dialog and is never inserted into the battlefield card arrays. */
function ExilePile({source,exiled,children}:{source:CardInstance;exiled:CardInstance[];children:React.ReactNode}) {
  if(!exiled.length)return children;
  return <div className="linked-exile-pile" data-exile-host={source.instanceId}>
    <div className="linked-exile-thumbnails" role="region" aria-label={`此永久物放逐的 ${exiled.length} 张公开牌`}>
      {exiled.map(card=><CardImage key={card.instanceId} card={card} grpId={card.grpId} className="exile-thumbnail" />)}
    </div>
    <div className="linked-exile-source">{children}</div>
  </div>;
}
