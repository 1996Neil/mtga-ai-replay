import { useRef } from 'react';
import { RelationshipArrows } from './RelationshipArrows';
import type { ParsedMatch, ReplayStep } from '../types/game';
import { PlayerInfo } from './PlayerInfo';
import { HandZone } from './HandZone';
import { BattlefieldZone, PermanentCard } from './BattlefieldZone';
import { GraveyardZone } from './GraveyardZone';
import { StackZone } from './StackZone';
import { CardInspectorOverlay } from './CardImage';
import { combatGroups } from '../lib/boardLayout';
import { FullCardRows } from './FullCardRows';
export function GameBoard({ step, match, viewBefore, analysis = false }: { step: ReplayStep; match: ParsedMatch; viewBefore: boolean; analysis?: boolean }) {
  const board = useRef<HTMLElement>(null);
  const state = viewBefore && step.beforeGameState ? step.beforeGameState : step.gameState;
  const { turnInfo, players, battlefieldByOwner, handByOwner, graveyardByOwner } = state;
  const localSeat = match.localSeatId, opponentSeat = 2;
  const own = players.find(p=>p.systemSeatId===localSeat), opponent = players.find(p=>p.systemSeatId===opponentSeat);
  // Before must not highlight card identities learned in the following event.
  const highlights = new Set(viewBefore ? [] : [Number(step.event?.card?.instance_id), ...(step.event?.targets ?? []).map(t=>Number(t.instance_id))].filter(Number.isFinite));
  const all = Object.values(battlefieldByOwner).flat();
  const combat = turnInfo.phase === 'Phase_Combat' ? combatGroups(all) : [];
  const fighting = new Set(combat.flatMap(g=>[g.attacker.instanceId,...g.blockers.map(c=>c.instanceId)]));
  const attackingMe = combat[0]?.attacker.controllerSeatId===localSeat;
  function field(seat: number) { return (battlefieldByOwner[seat] ?? []).filter(c=>!fighting.has(c.instanceId)); }
  const isLand = (card: typeof all[number]) => card.cardTypes.includes('CardType_Land') && !card.cardTypes.includes('CardType_Creature');
  function zones(seat: number) { return <div className="player-zones"><GraveyardZone cards={graveyardByOwner[seat] ?? []} label={`${seat===localSeat ? '我的' : '对手'}墓地`} shortLabel="墓地" />
    <GraveyardZone cards={state.exileObjects.filter(c=>c.ownerSeatId===seat)} label={`${seat===localSeat ? '我的' : '对手'}放逐区`} shortLabel="放逐区" /></div>; }
  return <main ref={board} className={`game-board full-card-board ${combat.length ? 'has-combat' : ''}`} aria-label="回放棋盘">
    <div className="player-header opponent-header">{opponent && <PlayerInfo player={opponent} isActive={turnInfo.activePlayer===opponentSeat} hasPriority={turnInfo.priorityPlayer===opponentSeat} isOpponent analysis={analysis} />}
      <HandZone cards={[]} count={opponent?.handSize ?? null} faceUp={false} />{zones(opponentSeat)}</div>
    <div className="board-play-area">
    <div className="board-land-column">
      <BattlefieldZone cards={field(opponentSeat).filter(isLand)} label="对手战场土地" isOpponent lands highlightIds={highlights} />
      <BattlefieldZone cards={field(localSeat).filter(isLand)} label="我的战场土地" lands highlightIds={highlights} />
    </div>
    <div className="board-main-column">
    <BattlefieldZone cards={field(opponentSeat).filter(card => !isLand(card))} label="对手战场" isOpponent highlightIds={highlights} compact={!!combat.length} />
    {!!combat.length && <section className={`combat-arena ${attackingMe ? 'attacking-up' : 'attacking-down'}`} aria-label="战斗对应关系">
      <h2>战斗 <span>{combat.length} 个攻击者 · {new Set(combat.flatMap(g=>g.blockers.map(c=>c.instanceId))).size} 个阻挡者</span></h2>
      <div className="combat-lanes">{combat.map(({attacker,blockers})=><div key={attacker.instanceId} className={`combat-lane ${blockers.length>1 ? 'multi-block' : ''}`} data-attacker={attacker.instanceId}>
        <FullCardRows className="combat-opponent-row" cards={attackingMe ? blockers : [attacker]}
          renderCard={card => <PermanentCard key={card.instanceId} card={card} highlighted={highlights.has(card.instanceId)} />} />
        <div className={`combat-connector ${blockers.length ? 'blocked' : 'unblocked'}`} aria-label={blockers.length ? `${blockers.length}个阻挡者对应此攻击者` : '未被阻挡'}><span>{blockers.length ? (blockers.length>1 ? `${blockers.length} 对 1` : '阻挡') : (attackingMe ? '↑ 未被阻挡' : '↓ 未被阻挡')}</span></div>
        <FullCardRows className="combat-local-row" cards={attackingMe ? [attacker] : blockers}
          renderCard={card => <PermanentCard key={card.instanceId} card={card} highlighted={highlights.has(card.instanceId)} />} />
      </div>)}</div>
    </section>}
    {!!state.stackObjects.length && <div className="contextual-stack"><StackZone cards={state.stackObjects} analysis={analysis} /></div>}
    <BattlefieldZone cards={field(localSeat).filter(card => !isLand(card))} label="我的战场" highlightIds={highlights} compact={!!combat.length} />
    </div>
    <CardInspectorOverlay />
    </div>
    <div className="player-header local-header">{own && <PlayerInfo player={own} isActive={turnInfo.activePlayer===localSeat} hasPriority={turnInfo.priorityPlayer===localSeat} isOpponent={false} analysis={analysis} />}{zones(localSeat)}</div>
    <HandZone cards={handByOwner[localSeat] ?? []} count={own?.handSize} faceUp />
    <RelationshipArrows board={board} state={state} event={viewBefore ? undefined : step.event} />
  </main>;
}
