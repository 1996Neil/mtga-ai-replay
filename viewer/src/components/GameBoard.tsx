import { useRef } from 'react';
import { RelationshipArrows } from './RelationshipArrows';
import type { ParsedMatch, ReplayStep } from '../types/game';
import { PlayerInfo } from './PlayerInfo';
import { HandZone } from './HandZone';
import { BattlefieldZone } from './BattlefieldZone';
import { GraveyardZone } from './GraveyardZone';
import { StackZone } from './StackZone';
import { CardInspectorOverlay } from './CardImage';
import { useCardCacheStore } from '../store/cardCacheStore';
import { combatPresentation, observedAttackTargets } from '../lib/combatPresentation';

export function GameBoard({ step, match, viewBefore, analysis = false }: { step: ReplayStep; match: ParsedMatch; viewBefore: boolean; analysis?: boolean }) {
  const board = useRef<HTMLElement>(null);
  const state = viewBefore && step.beforeGameState ? step.beforeGameState : step.gameState;
  const { turnInfo, players, battlefieldByOwner, handByOwner, graveyardByOwner } = state;
  const localSeat = match.localSeatId;
  const opponentSeat = players.find(player => player.systemSeatId !== localSeat)?.systemSeatId ?? (localSeat === 1 ? 2 : 1);
  const own = players.find(player => player.systemSeatId === localSeat), opponent = players.find(player => player.systemSeatId === opponentSeat);
  const event = viewBefore ? undefined : step.event;
  const highlights = new Set([Number(event?.card?.instance_id), ...(event?.targets ?? []).map(target => Number(target.instance_id))].filter(Number.isFinite));
  const metadata = useCardCacheStore(s => s.cards);
  const combat = combatPresentation(state, localSeat, event, {
    attackTargets: observedAttackTargets(match.steps, step, viewBefore),
    displayName: card => metadata.get(card.grpId)?.display_name_zh || card.name,
  });
  // Preserve source order and render each instance once, including during combat.
  const field = (seat: number) => battlefieldByOwner[seat] ?? [];
  const isLand = (card: typeof state.stackObjects[number]) => card.cardTypes.includes('CardType_Land') && !card.cardTypes.includes('CardType_Creature');
  function zones(seat: number) {
    return <div className="player-zones"><GraveyardZone cards={graveyardByOwner[seat] ?? []} label={`${seat === localSeat ? '我的' : '对手'}墓地`} shortLabel="墓地" />
      <GraveyardZone cards={state.exileObjects.filter(card => card.ownerSeatId === seat)} label={`${seat === localSeat ? '我的' : '对手'}放逐区`} shortLabel="放逐区" /></div>;
  }
  return <main ref={board} className="game-board full-card-board" aria-label="回放棋盘">
    <div className="board-scroll-controls" aria-label="矮窗口棋盘滚动"><span>棋盘可上下滚动</span><button type="button" onClick={() => board.current?.scrollTo({ top: 0 })}>查看棋盘上部</button><button type="button" onClick={() => { const el = board.current; if (el) el.scrollTo({ top: el.scrollHeight }); }}>查看棋盘下部</button></div>
    <div className="player-header opponent-header">{opponent && <PlayerInfo player={opponent} isActive={turnInfo.activePlayer === opponentSeat} hasPriority={turnInfo.priorityPlayer === opponentSeat} isOpponent analysis={analysis} />}
      <div className="player-extras"><HandZone cards={[]} count={opponent?.handSize ?? null} faceUp={false} />{zones(opponentSeat)}</div></div>
    <div className="board-play-area">
      <div className="board-land-column">
        <BattlefieldZone cards={field(opponentSeat).filter(isLand)} label="对手土地" isOpponent lands highlightIds={highlights} combatMarks={combat.marks} />
        <BattlefieldZone cards={field(localSeat).filter(isLand)} label="我的土地" lands highlightIds={highlights} combatMarks={combat.marks} />
        <HandZone cards={handByOwner[localSeat] ?? []} count={own?.handSize} faceUp />
      </div>
      <div className="board-main-column">
        <BattlefieldZone cards={field(opponentSeat).filter(card => !isLand(card))} label="对手战场" isOpponent highlightIds={highlights} combatMarks={combat.marks} />
        <section className="board-center-lane" aria-label="战斗状态">
          <div className="combat-summary" aria-label="战斗对应关系">
            <span>{combat.attackers ? `${combat.attackers} 个攻击者 · ${combat.blockers} 个阻挡者` : '战场'}</span>
            <span className="combat-legend">{combat.attackers ? '橙色攻击 · 蓝色阻挡 · 相同 A 编号相互对应' : '卡牌原位显示 · 可滚动查看全部'}</span>
          </div>
        </section>
        <BattlefieldZone cards={field(localSeat).filter(card => !isLand(card))} label="我的战场" highlightIds={highlights} combatMarks={combat.marks} />
      </div>
      {!!state.stackObjects.length && <div className="board-stack-overlay contextual-stack"><StackZone cards={state.stackObjects} analysis={analysis} /></div>}
    </div>
    <div className="player-header local-header">{own && <PlayerInfo player={own} isActive={turnInfo.activePlayer === localSeat} hasPriority={turnInfo.priorityPlayer === localSeat} isOpponent={false} analysis={analysis} />}<div className="player-extras">{zones(localSeat)}</div></div>
    <CardInspectorOverlay />
    <RelationshipArrows board={board} state={state} event={event} localSeat={localSeat} combatLinks={combat.links} />
  </main>;
}
