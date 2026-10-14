import type { PlayerState } from '../types/game';
interface Props { player: PlayerState; isActive: boolean; hasPriority: boolean; isOpponent: boolean; analysis?: boolean; }
export function PlayerInfo({ player, isActive, hasPriority, isOpponent, analysis = false }: Props) {
  return <div data-player-seat={player.systemSeatId} className={`player-info ${isOpponent ? 'opponent-info' : 'local-info'} ${isActive ? 'active-player' : ''}`}>
    <div className="player-identity"><span className="player-role">{isOpponent ? '对手' : '我'}</span><span className="player-name">{player.playerName}</span>
      {isActive && <span className="state-chip active-chip">当前行动</span>}{analysis && hasPriority && <span className="state-chip">优先权</span>}</div>
    <div className="life-total" aria-label={`生命 ${player.lifeTotal ?? '未知'}`}><span aria-hidden="true">♥</span><strong>{player.lifeTotal ?? '?'}</strong></div>
    <div className="player-zone-counts">手牌 {player.handSize ?? '?'}{analysis && <> · 牌库 {player.librarySize ?? '?'}</>}</div>
  </div>;
}
