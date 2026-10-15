// Stack snapshots are already top-first; preserve their recorded resolution order.
import { useId, useState } from 'react';
import type { CSSProperties } from 'react';
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
  const [collapsed, setCollapsed] = useState(false), [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (!cards.length) return null;
  return <section className={`stack-zone ${collapsed ? 'collapsed' : ''} ${expanded ? 'expanded' : 'overlapped'}`} aria-label="堆叠"
    style={{ '--stack-count': cards.length } as CSSProperties}>
    <header className="stack-heading"><span>堆叠 <b>{cards.length}</b></span><div className="stack-actions">
      {!collapsed && cards.length > 1 && <button type="button" aria-label={expanded ? '恢复堆叠叠放' : '展开全部堆叠'} aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(value => !value)}>{expanded ? '叠放' : '展开全部'}</button>}
      <button type="button" aria-label={collapsed ? '显示堆叠' : '收起堆叠'} aria-expanded={!collapsed} aria-controls={listId} onClick={() => setCollapsed(value => !value)}>{collapsed ? '显示 ‹' : '收起 ›'}</button>
    </div></header>
    <div className="stack-scroll" id={listId} role="region" aria-label="堆叠项目列表" tabIndex={0} hidden={collapsed}>
      <div className="stack-cards">
        {cards.map((c, i) => <div key={c.instanceId} className="stack-object" data-stack-order={i + 1}
          style={{ '--stack-index': i, '--stack-offset': Math.min(i, 3) * 6, zIndex: cards.length - i } as CSSProperties}>
          <div className="stack-order"><span>{i === 0 ? '下一项结算' : `第 ${i + 1} 项结算`}</span>{c.objectType?.includes('Ability') && <span className="stack-kind">异能</span>}</div>
          <CardImage grpId={c.grpId} card={c} className="stack-card" power={c.power} toughness={c.toughness} />
          {(analysis || !!c.targets?.length || !!c.targetIds?.length) && <div className="stack-details">
            {!!c.targets?.length && <div className="stack-targets"><span>目标 → </span>{c.targets.map((target, index) => <span key={index}>{index ? '，' : ''}<TargetLabel target={target} analysis={analysis} /></span>)}</div>}
            {!c.targets?.length && !!c.targetIds?.length && <div className="stack-targets">{analysis ? `目标 → ${c.targetIds.map(id => `#${id}`).join('，')}` : `已记录${c.targetIds.length}个目标`}</div>}
            {analysis && <small className="stack-instance">#{c.instanceId}</small>}
          </div>}
        </div>)}
      </div>
    </div>
  </section>;
}
