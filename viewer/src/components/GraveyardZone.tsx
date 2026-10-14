// Adapted from m1kk3l GraveyardZone; compact public-zone entry with a native dialog.
import { useEffect, useRef, useState } from 'react';
import type { CardInstance } from '../types/game';
import { useHoverStore } from '../store/hoverStore';
import { CardImage, CardInspectorOverlay } from './CardImage';
interface Props { cards: CardInstance[]; label: string; shortLabel: string; }
const zoneName = (value: string) => value.replace(/Opponent/gi, '对手').replace(/My/gi, '我的').replace(/public /gi, '').replace(/graveyard/gi, '墓地').replace(/exile/gi, '放逐区');
export function GraveyardZone({ cards, label, shortLabel }: Props) {
  const [open, setOpen] = useState(false), dialog = useRef<HTMLDialogElement>(null);
  const heading = zoneName(label), short = zoneName(shortLabel);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else { dialog.current?.close(); useHoverStore.getState().close(); }
  }, [open]);
  return <>
    <button type="button" className="zone-pile" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={`${heading}：${cards.length}张公开牌`}>
      <span>{short}</span><b>{cards.length}</b>
    </button>
    <dialog ref={dialog} className="zone-dialog" onCancel={() => setOpen(false)} onClose={() => setOpen(false)} onClick={e => { if (e.target === e.currentTarget) setOpen(false); }} aria-label={heading}>
      <header className="zone-dialog-header"><h2>{heading} <span>{cards.length}</span></h2><button type="button" className="standard-button" onClick={() => setOpen(false)} aria-label={`关闭${short}`}>关闭</button></header>
      <div className="zone-dialog-cards">{cards.length ? cards.map(c => <CardImage key={c.instanceId} grpId={c.grpId} card={c} className="zone-dialog-card" power={c.power} toughness={c.toughness} isToken={c.objectType === 'GameObjectType_Token'} />) : <p>此区域暂无公开牌。</p>}</div>
      {open && <CardInspectorOverlay />}
    </dialog>
  </>;
}
