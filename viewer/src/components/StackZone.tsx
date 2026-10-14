// Adapted from m1kk3l StackZone: newest stack object shown first; same-origin images.
import type { CardInstance } from '../types/game';
import { useCardImage } from '../hooks/useCardImage';
import { CardImage } from './CardImage';

function TargetLabel({ target, analysis }: { target: Record<string, unknown>; analysis: boolean }) {
  const hidden = target.hidden === true || /hidden|post.?game/i.test(String(target.visibility ?? ''));
  const info = useCardImage(hidden ? 0 : Number(target.arena_id ?? target.grpId ?? 0));
  if (hidden) return <span>未知目标</span>;
  if (target.player) return <span>{target.player === 'me' ? '我' : target.player === 'opponent' ? '对手' : '玩家'}</span>;
  const english = target.name ?? info.name;
  return <span title={String(english ?? '')}>{info.displayNameZh ?? String(english ?? (analysis ? `#${target.instance_id ?? target.instanceId ?? '?'}` : '已记录目标'))}</span>;
}

export function StackZone({ cards, analysis = false }: { cards: CardInstance[]; analysis?: boolean }) {
  if (!cards.length) return null;
  return <section className="stack-zone" aria-label="堆叠">
    <header className="stack-heading">堆叠 <span>{cards.length}</span></header>
    <div className="stack-cards">
      {[...cards].reverse().map((c, i) => <div key={c.instanceId} className="stack-object">
        <span className="stack-order">{i === 0 ? '下一项结算' : `第${i + 1}项`}{c.objectType?.includes('Ability') ? ' · 异能' : ''}</span>
        <CardImage grpId={c.grpId} card={c} className="stack-card" power={c.power} toughness={c.toughness} />
        {!!c.targets?.length && <div className="stack-targets"><span>目标 → </span>{c.targets.map((target, index) => <span key={index}>{index ? '，' : ''}<TargetLabel target={target} analysis={analysis} /></span>)}</div>}
        {!c.targets?.length && !!c.targetIds?.length && <div className="stack-targets">{analysis ? `目标 → ${c.targetIds.map(id => `#${id}`).join('，')}` : `已记录${c.targetIds.length}个目标`}</div>}
        {analysis && <small className="stack-instance">#{c.instanceId}</small>}
      </div>)}
    </div>
  </section>;
}
