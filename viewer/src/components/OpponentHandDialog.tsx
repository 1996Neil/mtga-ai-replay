import { useEffect, useRef } from 'react';
import type { CardInstance } from '../types/game';
import { CardImage } from './CardImage';

/** Only known cards confirmed to remain in hand; unknown identities never resolve images. */
export function OpponentHandDialog({ open, onClose, cards, count }: {
  open: boolean; onClose: () => void; cards: CardInstance[]; count: number | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const missing = count == null ? null : Math.max(0, count - cards.length);
  return <dialog ref={dialog} className="zone-dialog opponent-hand-dialog" aria-label="对手手牌"
    onCancel={onClose} onClose={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header className="zone-dialog-header"><h2>对手手牌 <span>{count ?? '?'}</span></h2>
      <button type="button" className="standard-button" onClick={onClose} aria-label="关闭对手手牌">关闭</button></header>
    <div className="zone-dialog-cards">{cards.length ? cards.map(card =>
      <CardImage key={card.instanceId} card={card} grpId={card.grpId} className="zone-dialog-card" />)
      : <p>当前没有能确认仍在手中的已知牌。</p>}</div>
    {missing != null && missing > 0 && <p className="unknown-hand-count">另有 {missing} 张未展示的手牌。</p>}
  </dialog>;
}
