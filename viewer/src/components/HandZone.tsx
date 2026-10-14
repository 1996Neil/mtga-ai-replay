// Adapted from m1kk3l HandZone: face-up own hand and count-only opponent backs.
import type { CardInstance } from '../types/game';
import { FullCardRows } from './FullCardRows';
interface Props { cards: CardInstance[]; faceUp: boolean; count?: number | null; }
export function HandZone({ cards, faceUp, count }: Props) {
  if (!faceUp) {
    const n = count === null ? null : count ?? cards.length;
    return <div className="opponent-hand" aria-label={`对手手牌：${n ?? '未知'}张；牌面隐藏`}>
      <span>手牌 <b>{n ?? '?'}</b></span>
      <div className="opponent-hand-backs" aria-hidden="true">{Array.from({ length: Math.min(n ?? 0, 7) }, (_, i) => <div key={i} className="card-back" />)}</div>
    </div>;
  }
  const missing = typeof count === 'number' ? Math.max(0, count - cards.length) : 0;
  return <section className={`own-hand ${cards.length ? '' : 'empty'}`} aria-label="当前回放位置的我的手牌">
    <div className="hand-label">我的手牌 <b>{count ?? cards.length}</b>{missing > 0 && <span> · {missing}张牌面未记录</span>}</div>
    {cards.length ? <FullCardRows cards={cards} maxCardWidth={118} className="full-hand-cards" />
      : <span className="empty-hand-label">{count ? '手牌牌面未记录' : '暂无手牌'}</span>}
  </section>;
}
