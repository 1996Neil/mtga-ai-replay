import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { DraftRun, CardInstance } from '../types/game';
import { CardImage } from './CardImage';
import { useCardImage } from '../hooks/useCardImage';
import { draftDeckInputKey, deckCardCount, deckRows, deckManaColumns, deckDifferenceCount, parseDraftDeckResponse } from '../lib/draftDecks';
import type { DraftDeckCard, DraftDeckResponse, DeckChanges } from '../lib/draftDecks';
import './DraftDeckComparison.css';

function cardInstance(card: DraftDeckCard): CardInstance {
  return { instanceId: card.arena_id, grpId: card.arena_id, name: card.name, manaCost: card.mana_cost ?? undefined,
    zoneId: 0, ownerSeatId: 0, controllerSeatId: 0, cardTypes: [],
    isTapped: false, isAttacking: false, counters: {} };
}
function ChangeCard({ card }: { card: DeckChanges['added'][number] }) {
  const info = useCardImage(card.arena_id);
  return <span>{card.quantity}× {info.displayNameZh ?? card.name}</span>;
}
function Changes({ changes, title, addLabel, removeLabel }: {
  changes: DeckChanges; title: string; addLabel: string; removeLabel: string;
}) {
  if (!changes.added.length && !changes.removed.length) return <p className="deck-no-changes">{title}：牌表相同。</p>;
  return <section className="deck-change-list" aria-label={title}>
    <h4>{title} · {deckDifferenceCount(changes)} 张调整</h4>
    {changes.added.length > 0 && <div className="deck-change-add"><b>＋ {addLabel}</b>
      {changes.added.map(card => <ChangeCard key={card.key} card={card} />)}</div>}
    {changes.removed.length > 0 && <div className="deck-change-remove"><b>− {removeLabel}</b>
      {changes.removed.map(card => <ChangeCard key={card.key} card={card} />)}</div>}
  </section>;
}
function DeckTile({ card, delta = 0, removed = false }: {
  card: DraftDeckCard; delta?: number; removed?: boolean;
}) {
  return <div className={'draft-deck-tile' + (delta ? removed ? ' deck-removed' : ' deck-added' : '')}>
    <CardImage grpId={card.arena_id} card={cardInstance(card)} showCaption={false} fallbackLabel={card.display_name_zh ?? card.name} />
    <span className="draft-deck-card-quantity" aria-label={`${card.name} ${card.quantity}张`}>×{card.quantity}</span>
    {delta > 0 && <span className="draft-deck-delta" aria-label={`${removed ? '建议移出' : '建议加入'}${delta}张`}>
      {removed ? '−' : '＋'}{delta}</span>}
  </div>;
}
function RemovedCards({ cards, comparison, version }: {
  cards: DraftDeckCard[]; comparison: DeckChanges; version: number;
}) {
  const removed = cards.flatMap(card => {
    const change = comparison.removed.find(value => value.key === card.key);
    return change ? [{ ...card, quantity: change.quantity }] : [];
  }).sort((a, b) => (a.mana_value ?? Infinity) - (b.mana_value ?? Infinity));
  if (!removed.length) return null;
  return <section className="draft-deck-removals" aria-label={`相比你的版本${version}建议移出的卡牌`}>
    <h4>建议移出 <span>−{deckCardCount(removed)} 张 · 相比你的版本 {version}</span></h4>
    <div className="draft-deck-removals-grid">{removed.map(card => <figure key={card.key}>
      <DeckTile card={card} delta={card.quantity} removed />
      <figcaption>{card.display_name_zh ?? card.name}</figcaption>
    </figure>)}</div>
  </section>;
}
interface DeckLayout {
  columns: Array<number | null>;
  rowStackCounts: Record<'creature' | 'other', number>;
}
function DeckBoard({ cards, comparison, side, label, layout }: {
  cards: DraftDeckCard[]; comparison?: DeckChanges | null; side: 'recommendation' | 'actual'; label: string;
  layout: DeckLayout;
}) {
  const rows = useMemo(() => deckRows(cards), [cards]);
  const { columns, rowStackCounts } = layout;
  const changed = new Map((side === 'recommendation' ? comparison?.added : comparison?.removed)?.map(card => [card.key, card.quantity]) ?? []);
  const columnsStyle = { '--deck-columns': columns.length } as CSSProperties;
  return <div className="draft-deck-board" aria-label={label} style={columnsStyle}>
    <div className="draft-deck-costs" aria-label="费用从低到高">{columns.map(cost =>
      <span key={cost ?? 'unknown'}>{cost === null ? '未知' : `${cost}费`}</span>)}</div>
    {rows.map(row => <section key={row.category} className="draft-deck-type" aria-label={`${row.label} ${row.count}张`}>
      <h4>{row.label}<span>{row.count}</span></h4>
      <div className="draft-deck-type-columns" style={{
        '--deck-row-ratio': 1 / (1.4 + Math.max(0, rowStackCounts[row.category] - 1) * 0.9),
      } as CSSProperties}>{columns.map((cost, column) => {
        const stack = row.cards.filter(card => card.mana_value === cost)
          .sort((a, b) => (a.display_name_zh ?? a.name).localeCompare(b.display_name_zh ?? b.name));
        return <div className="draft-deck-stack" key={cost ?? 'unknown'} data-mana-value={cost ?? 'unknown'} style={{ gridColumn: column + 1 }}>
          {stack.map(card => <DeckTile key={card.key} card={card} delta={changed.get(card.key)} removed={side === 'actual'} />)}
        </div>;
      })}</div>
    </section>)}
  </div>;
}
function DeckStats({ cards }: { cards: DraftDeckCard[] }) {
  const lands = deckCardCount(cards.filter(card => card.category === 'land'));
  const creatures = deckCardCount(cards.filter(card => card.category === 'creature'));
  return <p className="draft-deck-stats"><strong>{deckCardCount(cards)} 张</strong><span>{creatures} 生物</span><span>{lands} 地</span></p>;
}
export function DraftDeckComparison({ run, accountKey }: { run: DraftRun; accountKey: string }) {
  const identity = draftDeckInputKey(run, accountKey);
  const [snapshot, setSnapshot] = useState<{ identity: string; data: DraftDeckResponse | null; error: string }>({ identity, data: null, error: '' });
  const [version, setVersion] = useState(0), epoch = useRef(0);
  const data = snapshot.identity === identity ? snapshot.data : null;
  const error = snapshot.identity === identity ? snapshot.error : '';
  useEffect(() => {
    const controller = new AbortController(), ticket = ++epoch.current;
    setSnapshot({ identity, data: null, error: '' });
    void (async () => {
      try {
        const response = await fetch(`/api/draft-runs/${encodeURIComponent(run.run_id)}/decks?account=${encodeURIComponent(accountKey)}`,
          { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw Error(`卡组读取失败（${response.status}），请重试。`);
        const value = parseDraftDeckResponse(await response.json(), run, accountKey);
        if (!controller.signal.aborted && ticket === epoch.current) setSnapshot({ identity, data: value, error: '' });
      } catch (error) {
        if (!controller.signal.aborted && ticket === epoch.current)
          setSnapshot({ identity, data: null, error: error instanceof Error ? error.message : '卡组读取失败。' });
      }
    })();
    return () => { controller.abort(); epoch.current++; };
  }, [identity, version]);
  const recommendation = data?.recommendation;
  const firstComparison = data?.versions[0]?.comparison;
  const layout = useMemo<DeckLayout>(() => {
    const decks = [data?.recommendation?.cards ?? [], ...(data?.versions.map(deck => deck.cards) ?? [])];
    const columns = deckManaColumns(decks.flat());
    const rowStackCounts = { creature: 0, other: 0 };
    for (const cards of decks) for (const row of deckRows(cards)) for (const cost of columns)
      rowStackCounts[row.category] = Math.max(rowStackCounts[row.category], row.cards.filter(card => card.mana_value === cost).length);
    return { columns, rowStackCounts };
  }, [data]);
  return <section className="draft-deck-comparison" aria-label="推荐卡组与实战版本">
    <header className="draft-deck-comparison-heading">
      <div><h3>构筑对比</h3><p>生物／其他 · 费用从左到右</p></div>
      <button type="button" className="standard-button" onClick={() => setVersion(value => value + 1)}>刷新卡组</button>
    </header>
    {error ? <p role="alert" className="draft-notice">{error}</p> : !data ? <p role="status">正在整理卡组版本…</p> :
      !data.finished ? <p>选牌完成后，这里会显示推荐构筑和实际使用的版本。</p> :
      <div className="draft-deck-comparison-grid">
        <article className="draft-deck-panel draft-recommended-deck">
          <header><span className="draft-deck-eyebrow">教练推荐</span><h3>{recommendation?.title ?? '这场的推荐卡组还没整理'}</h3>
            {recommendation && <DeckStats cards={recommendation.cards} />}
          </header>
          {recommendation ? <>
            <DeckBoard cards={recommendation.cards} comparison={firstComparison} side="recommendation" label="教练推荐卡组" layout={layout} />
            {firstComparison && data.versions[0] && <RemovedCards cards={data.versions[0].cards}
              comparison={firstComparison} version={data.versions[0].version} />}
            <div className="draft-deck-coaching">{recommendation.plan.split(/\n\s*\n/).filter(Boolean).map((paragraph, i) => <p key={i}>{paragraph}</p>)}
              {recommendation.choices.map((choice, i) => <section key={i}><h4>{choice.title}</h4><p>{choice.reason}</p></section>)}
            </div>
          </> : <p className="draft-muted">{data.recommendation_status === 'stale' ? '牌池已更新，推荐需要重新整理。' :
            data.recommendation_status === 'error' ? '推荐卡组暂时无法读取，可点击刷新卡组重试。' : '先保留右侧真实使用过的版本。'}</p>}
        </article>
        <div className="draft-actual-decks">
          {data.versions.length === 0 ? <p className="draft-muted">这场还没有可读取的实战牌表。</p> :
            data.versions.map(deck => <article key={`${deck.version}-${deck.fingerprint}`} className="draft-deck-panel">
              <header><span className="draft-deck-eyebrow">你的卡组 · {data.versions.length} 个版本</span>
                <h3>版本 {deck.version}<span>{deck.matches.length} 场 · {deck.wins} 胜 {deck.losses} 负</span></h3>
                <DeckStats cards={deck.cards} />
              </header>
              <DeckBoard cards={deck.cards} comparison={deck.comparison} side="actual" label={`你的卡组版本${deck.version}`} layout={layout} />
              <div className="draft-deck-version-changes">
                {deck.version > 1 && <Changes changes={deck.changes_from_previous} title="相比上一版" addLabel="加入" removeLabel="移出" />}
                {deck.comparison && <Changes changes={deck.comparison} title="调整为推荐构筑" addLabel="建议加入" removeLabel="建议移出" />}
              </div>
              <details className="draft-deck-usage"><summary>使用记录 · {deck.matches.length} 场</summary>
                {deck.matches.map(match => <p key={match.id}>
                  <time>{new Date(match.started_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</time>
                  <span>{match.result === 'Win' ? '胜' : match.result === 'Loss' ? '负' : '结果未知'}</span>
                </p>)}
              </details>
            </article>)}
        </div>
      </div>}
  </section>;
}
