import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { DraftRun, CardInstance } from '../types/game';
import { CardImage, CardInspectorOverlay } from './CardImage';
import { useCardCacheStore } from '../store/cardCacheStore';
import { useHoverStore } from '../store/hoverStore';
import { draftPickIndex, draftPickKey, draftPickWarning, draftPoolIsPartial, orderedDraftPicks, visibleDraftRuns, draftBindingLabel, selectedCardColumns } from '../lib/draftReplay';
import type { DraftCard } from '../lib/draftReplay';
import { formatEventName, formatMatchTime } from '../lib/historyPresentation';
import { useDraftReview } from '../hooks/useDraftReview';
import { DraftReviewCoach } from './DraftReviewCoach';
import { DraftDeckComparison } from './DraftDeckComparison';
import { draftDeckSelectionFinished } from '../lib/draftDecks';
import { draftNotePresentation, draftReviewPickKey } from '../lib/draftReview';
import './DraftReplay.css';

interface Props {
  runs: DraftRun[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  error?: string;
  accountKey: string;
  onOpenMatch?: (id: string, accountKey?: string) => void;
}

function previewCard(card: DraftCard): CardInstance {
  return { instanceId: card.arena_id, grpId: card.arena_id, name: card.name,
    zoneId: 0, ownerSeatId: 0, controllerSeatId: 0, cardTypes: [],
    isTapped: false, isAttacking: false, counters: {} };
}

function SelectedCards({ cards, selectedId }: { cards: DraftCard[]; selectedId?: number }) {
  const metadata = useCardCacheStore(state => state.cards);
  const columns = useMemo(() => selectedCardColumns(cards, metadata), [cards, metadata]);
  return <section className="draft-selected-cards" aria-labelledby="draft-selected-heading">
    <div className="draft-section-heading"><h3 id="draft-selected-heading">已选的牌 <span>{cards.length} 张</span></h3>
      <span className="draft-muted">截至本手 · 费用从左到右</span></div>
    {columns.length ? <div className="draft-selected-scroll">
      <div className="draft-selected-columns" style={{ '--selected-columns': columns.length } as CSSProperties}>
        {columns.map(({ cost, cards }) => <section className="draft-selected-column" key={cost ?? 'unknown'}
          data-mana-value={cost ?? 'unknown'} aria-label={cost === null ? '费用待识别' : `${cost}费已选牌`}>
          <h4>{cost === null ? '待识别' : `${cost}费`}<span>{cards.reduce((sum, card) => sum + card.count, 0)} 张</span></h4>
          <div className="draft-selected-stack">{cards.map(card => <div key={card.arena_id}
            className={'draft-selected-tile' + (card.arena_id === selectedId ? ' current-selection' : '')}>
            <CardImage grpId={card.arena_id} card={previewCard(card)} showCaption={false} fallbackLabel={card.name} />
            {card.count > 1 && <span className="draft-selected-quantity" aria-label={`${card.name} ${card.count} 张`}>×{card.count}</span>}
          </div>)}</div>
        </section>)}
      </div>
    </div> : <p className="draft-muted">本手尚无已保存的选择。</p>}
  </section>;
}

export function DraftReplay({ runs: sourceRuns, selectedRunId, onSelectRun, error, accountKey, onOpenMatch }: Props) {
  const runs = useMemo(() => visibleDraftRuns(sourceRuns), [sourceRuns]);
  const run = runs.find(value => value.run_id === selectedRunId) ?? runs[0];
  const [libraryCollapsed, setLibraryCollapsed] = useState(() => {
    try { return localStorage.getItem('mtga-replay:draft-library-collapsed') === 'true'; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('mtga-replay:draft-library-collapsed', String(libraryCollapsed)); }
    catch { /* The toggle remains usable when browser storage is unavailable. */ }
  }, [libraryCollapsed]);
  return <main id="draft-workspace" tabIndex={-1}
    className={'draft-workspace' + (libraryCollapsed ? ' library-collapsed' : '')} aria-label="轮抽选牌回看">
    <aside className="draft-library" aria-label="选择轮抽">
      <div className="draft-library-heading">
        <h2 hidden={libraryCollapsed}>轮抽记录</h2><span hidden={libraryCollapsed}>{runs.length} 场</span>
        <button type="button" className="draft-library-toggle"
          aria-expanded={!libraryCollapsed} aria-controls="draft-library-content"
          aria-label={libraryCollapsed ? '展开轮抽记录' : '收起轮抽记录'}
          title={libraryCollapsed ? '展开轮抽记录' : '收起轮抽记录'}
          onClick={() => setLibraryCollapsed(value => !value)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            aria-hidden="true"><path d={libraryCollapsed ? 'm9 5 7 7-7 7' : 'm15 5-7 7 7 7'} /></svg>
          <span>{libraryCollapsed ? '轮抽记录' : '收起'}</span>
        </button>
      </div>
      <div id="draft-library-content" hidden={libraryCollapsed}>
      <p className="draft-muted">按时间从新到旧 · 仅显示有选牌的场次</p>
      {error && <p className="draft-notice" role="status">{error}</p>}
      <div className="draft-run-list">{runs.map(item => <button type="button" key={item.run_id}
        className={'draft-session' + (item.run_id === run?.run_id ? ' active' : '')}
        aria-pressed={item.run_id === run?.run_id} onClick={() => onSelectRun(item.run_id)}>
        <strong>{formatEventName(item.event)}</strong>
        <time>{formatMatchTime(item.started_at ?? '')}</time>
        <span>{item.picks.length} 手已记录
          <span>{draftBindingLabel(item)}</span>
        </span>
      </button>)}</div>
      <p className="draft-library-footnote">按当前游戏账号显示<br />仅回看已保存的选择</p>
      </div>
    </aside>
    {run ? <DraftSession key={run.run_id} run={run} accountKey={accountKey} onOpenMatch={onOpenMatch} /> : <div className="draft-empty">
      <span className="draft-eyebrow">DRAFT REPLAY</span><h2>当前账号还没有选牌记录</h2>
      <p>采集到新的选牌后，这里会自动出现候选包、实际选择和逐手牌池。</p>
      <p className="draft-muted">可在顶部切换游戏账号。历史中未采集的选牌无法还原。</p>
    </div>}
  </main>;
}

function DraftSession({ run, accountKey, onOpenMatch }: { run: DraftRun; accountKey: string; onOpenMatch?: Props['onOpenMatch'] }) {
  const picks = useMemo(() => orderedDraftPicks(run.picks), [run.picks]);
  const review = useDraftReview(run, accountKey);
  const comments = useMemo(() => new Map((review.review?.notes ?? []).map(note =>
    [draftReviewPickKey(note), note])), [review.review]);
  const [pickKey, setPickKey] = useState('');
  const [commentSelection, setCommentSelection] = useState(0);
  const [sessionView, setSessionView] = useState<'picks' | 'decks'>('picks');
  const index = draftPickIndex(picks, pickKey), pick = picks[index];
  const packs = [...new Set(picks.map(p => p.pack_number))];
  const currentKey = pick && draftPickKey(pick);
  const partialPool = draftPoolIsPartial(picks, index);
  const warning = pick && draftPickWarning(pick, partialPool);
  const selectedIndex = pick?.selected ? pick.candidates.findIndex(card => card.arena_id === pick.selected!.arena_id) : -1;
  const selectPick = (key: string) => {
    setPickKey(key);
    if (comments.has(key)) setCommentSelection(value => value + 1);
  };
  const setIndex = (next: number) => { if (picks[next]) selectPick(draftPickKey(picks[next])); };

  useEffect(() => {
    useHoverStore.getState().close();
    return () => useHoverStore.getState().close();
  }, [currentKey]);

  useEffect(() => {
    function navigate(event: KeyboardEvent) {
      if (sessionView !== 'picks' || event.altKey || event.ctrlKey || event.metaKey || document.querySelector('dialog[open]') ||
        (event.target instanceof HTMLElement && (event.target.closest('input,select,textarea,summary,[role="dialog"]') || event.target.isContentEditable))) return;
      let next: number;
      switch (event.key) {
        case 'ArrowLeft': next = index - 1; break;
        case 'ArrowRight': next = index + 1; break;
        case 'Home': next = 0; break;
        case 'End': next = picks.length - 1; break;
        default: return;
      }
      event.preventDefault();
      if (picks[next]) selectPick(draftPickKey(picks[next]));
    }
    window.addEventListener('keydown', navigate);
    return () => window.removeEventListener('keydown', navigate);
  }, [picks, index, comments, sessionView]);

  return <section className="draft-session-workspace" aria-label={formatEventName(run.event)}>
    <header className="draft-heading">
      <div><span className="draft-eyebrow">DRAFT REPLAY</span><h2>{formatEventName(run.event)}</h2>
        <p className="draft-muted">{formatMatchTime(run.started_at ?? '')} · {picks.length} 手已记录</p>
      </div>
      <div className="draft-heading-actions">
        <DraftReviewCoach snapshot={review} currentKey={currentKey} selectionVersion={commentSelection}
          onJump={key => { setSessionView('picks'); setPickKey(key); }}
          onPreview={card => useHoverStore.getState().togglePinned(previewCard(card))}
          onRefresh={review.refresh} />
        <span className="draft-readonly">历史选牌回看</span>
      </div>
    </header>
    <div className="draft-view-tabs" role="tablist" aria-label="轮抽查看内容">
      <button type="button" role="tab" aria-selected={sessionView === 'picks'}
        aria-controls="draft-picks-view" id="draft-picks-tab" onClick={() => setSessionView('picks')}>选牌过程</button>
      <button type="button" role="tab" aria-selected={sessionView === 'decks'}
        aria-controls="draft-decks-view" id="draft-decks-tab" onClick={() => setSessionView('decks')}>构筑对比</button>
    </div>
    {run.capture_source && (run.binding === 'matched_pool'
      ? <div className="draft-binding-summary">
        <strong>已关联 {run.matches.length} 场对战 · {run.score_verified ? '' : '归档 '}{run.replay_wins} 胜 {run.replay_losses} 负</strong>
        <p>{run.binding_card_count} 张实际选择与赛事牌池逐张吻合，包含重复张数；已逐场核对对战主牌组。
          {(run.capture_run_ids?.length ?? 0) > 1 && ` 已合并 ${run.capture_run_ids!.length} 段重复采集。`}</p>
        {!run.score_verified && <p className="draft-pool-caution">战绩按已归档对战统计，赛事总战绩尚未核验。</p>}
        {!!run.binding_pending_matches && <p className="draft-pool-caution">另有 {run.binding_pending_matches} 场等待对战上传或版本核对，完成后自动补全。</p>}
        {run.binding_account_status !== 'matched' && <p className="draft-pool-caution">
          {run.binding_account_status === 'conflict' ? '选牌与对战的账号记录不一致；关联保留，账号归属未改写。打开对战时会切换到对战所属账号。' : '牌池关系已核对，但账号归属仍不完整。'}
        </p>}
        <details className="draft-linked-matches"><summary>查看关联对战 · {run.matches.length} 场</summary>
          {run.matches.map(match => <button type="button" key={match.id} disabled={!onOpenMatch}
            onClick={() => onOpenMatch?.(match.id, match.account_key ?? run.binding_account_key ?? 'unassigned')}>
            <time>{formatMatchTime(match.started_at)}</time><span>{match.result === 'Win' ? '胜' : match.result === 'Loss' ? '负' : '结果未知'}</span><span>打开回放 →</span>
          </button>)}
        </details>
      </div>
      : null)}
    {sessionView === 'decks' ? <div id="draft-decks-view" role="tabpanel" aria-labelledby="draft-decks-tab">
      <DraftDeckComparison run={run} accountKey={accountKey} />
    </div> : <div id="draft-picks-view" role="tabpanel" aria-labelledby="draft-picks-tab">
    {!pick ? <div className="draft-empty"><h3>这场轮抽没有逐手记录</h3>
      <p>已有赛事牌池无法还原每一手的候选包；后续采集到的选牌会自动显示。</p>
    </div> : <>
      <div className="draft-table">
        <aside className="draft-side" aria-label="选牌控制">
        <nav className="draft-navigation" aria-label="选牌进度">
        <div className="draft-pack-tabs" aria-label="选择补充包">{packs.map(pack => {
          const count = [...comments.values()].filter(note => note.pack_number === pack).length;
          return <button type="button" key={pack} aria-pressed={pick.pack_number === pack}
            aria-label={`第 ${pack} 包${count ? `，${count} 手有 AI 评论` : ''}`}
            onClick={() => selectPick(draftPickKey(picks.find(p => p.pack_number === pack)!))}>
            第 {pack} 包{count > 0 && <span className="draft-pack-review-count">{count}</span>}
          </button>;
        })}</div>
        <div className="draft-pick-navigation">
          <strong aria-live="polite" aria-atomic="true">第 {pick.pack_number} 包 · 第 {pick.pick_number} 手</strong>
          <button type="button" disabled={index === 0} onClick={() => setIndex(index - 1)} aria-label="上一手">← 上一手</button>
          <button type="button" disabled={index === picks.length - 1} onClick={() => setIndex(index + 1)} aria-label="下一手">下一手 →</button>
        </div>
        <div className="draft-pick-strip" aria-label={`第 ${pick.pack_number} 包的已记录选牌`}>
          {picks.filter(p => p.pack_number === pick.pack_number).map(p => {
            const note = comments.get(draftPickKey(p)), appearance = note && draftNotePresentation(note);
            return <button type="button" key={draftPickKey(p)}
            aria-label={`第 ${p.pack_number} 包第 ${p.pick_number} 手${p.complete ? '' : '，记录不完整'}${appearance ? `，有 AI 评论，${appearance.accessible}` : ''}`}
            aria-current={draftPickKey(p) === currentKey ? 'step' : undefined}
            title={note ? `${note.title} · ${appearance!.judgment}` : undefined}
            data-review-tone={appearance?.tone}
            className={(p.complete ? '' : 'has-gap ') + (appearance ? 'has-review' : '')}
            onClick={() => selectPick(draftPickKey(p))}>
            {p.pick_number}{appearance && <span className="draft-review-pick-symbol" aria-hidden="true">{appearance.symbol}</span>}
            {!p.complete && <span aria-hidden="true">·</span>}
          </button>;
          })}
        </div>
        {comments.size > 0 && <p className="draft-review-legend" aria-label="AI 评论抓位图例">
          <span className="severity-text-positive">✓ 值得保留</span>
          <span className="severity-text-tip">i 策略建议</span>
          <span className="severity-text-major">◆ 建议核查</span>
        </p>}
        <label className="draft-scrubber"><span>已记录进度 {index + 1} / {picks.length}</span>
          <input type="range" aria-label="浏览已记录选牌" min={0} max={Math.max(0, picks.length - 1)} value={index}
            aria-valuetext={`第 ${pick.pack_number} 包第 ${pick.pick_number} 手，已记录第 ${index + 1} 手`}
            onChange={event => setIndex(Number(event.target.value))} />
        </label>
        </nav>
        </aside>
        <section className="draft-pack" aria-labelledby="draft-pack-heading">
          {warning && <p className="draft-notice" role="status">{warning}</p>}
          <div className="draft-section-heading"><h3 id="draft-pack-heading">本手候选包 <span>{pick.candidates.length} 张</span></h3>
            <span className="draft-muted">点击卡牌放大</span></div>
          <p className="draft-pick-result">实际选择：<strong>{pick.selected?.name ?? '缺少选择记录'}</strong></p>
          {pick.candidates.length ? <div className="draft-candidate-grid">
            {pick.candidates.map((card, i) => <div key={`${card.arena_id}-${pick.candidates.slice(0, i).filter(prior => prior.arena_id === card.arena_id).length}`}
              className={'draft-candidate' + (i === selectedIndex ? ' chosen' : '')}>
              <CardImage grpId={card.arena_id} card={previewCard(card)} fallbackLabel={card.name} />
              {i === selectedIndex && <span className="draft-chosen-label">✓ 实际选择</span>}
            </div>)}
          </div> : <div className="draft-pack-missing"><h4>本手候选包未被记录</h4>
            <p>可继续浏览其他手；不会用最终牌池推测这里的卡牌。</p></div>}
          {pick.selected && selectedIndex < 0 && <div className="draft-unmatched-selection">
            <p>单独保存的选择记录</p><CardImage grpId={pick.selected.arena_id} card={previewCard(pick.selected)} />
          </div>}
          <SelectedCards cards={pick.pool_after} selectedId={pick.selected?.arena_id} />
          <p className="draft-keyboard-hint">← → 切换已记录的手 · Home / End 跳到首尾 · 编号间断表示缺少记录</p>
          {index === picks.length - 1 && draftDeckSelectionFinished(run) && <button type="button" className="draft-finished-deck-link"
            onClick={() => setSessionView('decks')}>查看推荐卡组与实战版本 →</button>}
        </section>
      </div>
    </>}
    </div>}
    <CardInspectorOverlay />
  </section>;
}
