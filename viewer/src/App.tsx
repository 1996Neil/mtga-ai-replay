// Data-loading shell replaces the upstream upload worker. It consumes the local canonical API.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useReplayStore } from './store/replayStore';
import { useHoverStore } from './store/hoverStore';
import { useReplayEngine } from './hooks/useReplayEngine';
import { normalizeHistory, normalizeReplay, normalizeDraftRuns } from './lib/canonicalAdapter';
import type { DraftRun, HistoryMatch } from './types/game';
import { GameBoard } from './components/GameBoard';
import { GameLog } from './components/GameLog';
import { ReplayControls } from './components/ReplayControls';
import { ReplaySyncButton } from './components/ReplaySyncButton';
import { CollectionUpdateButton } from './components/CollectionUpdateButton';
import { integrityMessages } from './lib/integrity';
import { ReplayReviewCoach } from './components/ReplayReviewCoach';

import { formatMatchTime as when, formatEventName, draftRunStatusLabel, draftRunScoreMessage } from './lib/historyPresentation';
const COLOR_LABELS: Record<string, string> = { W: '白', U: '蓝', B: '黑', R: '红', G: '绿' };

export function App() {
  const [history, setHistory] = useState<HistoryMatch[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [draftRuns, setDraftRuns] = useState<DraftRun[]>([]);
  const [account, setAccount] = useState('unassigned');
  const [accounts, setAccounts] = useState<{ account_key: string; label: string }[]>([]);
  const accountChosen = useRef(false);
  const [draftError, setDraftError] = useState('');
  const [anchorInput, setAnchorInput] = useState(''), [anchorError, setAnchorError] = useState('');
  const [showWarnings, setShowWarnings] = useState(false);
  const [analysis, setAnalysis] = useState(false);
  const [publishedSource, setPublishedSource] = useState<{ revision: string; content_hash: string } | null>(null);
  useEffect(() => { const controller = new AbortController();
    void fetch('/api/source', { signal: controller.signal, cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(value => {
      if (!controller.signal.aborted && value?.kind === 'published-history' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.revision) && /^[a-f0-9]{64}$/.test(value.content_hash)) setPublishedSource(value);
    }).catch(() => {});
    return () => controller.abort();
  }, []);
  const s = useReplayStore(), match = s.currentMatch(), step = s.currentStep();
  const actualBefore = s.viewBefore && Boolean(step?.beforeGameState);
  const request = useRef<AbortController | null>(null);
  const historyEntries = useRef<HistoryMatch[]>([]);
  const historyPicker = useRef<HTMLDetailsElement>(null);
  const navigating = useRef(false);
  const loadedRevision = useRef<{ id: string; revision?: string } | null>(null);
  useReplayEngine();

  const loadMatch = useCallback(async (id: string, anchor?: string, gameNumber?: number) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    navigating.current = true;
    const revision = historyEntries.current.find(entry => entry.id === id)?.revision;
    setLoading(true); setError(''); setAnchorError('');
    useReplayStore.getState().pause();
    try {
      const response = await fetch(`/api/matches/${encodeURIComponent(id)}?account=${encodeURIComponent(account)}`, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`无法加载回放（${response.status}），请稍后重新选择比赛。`);
      const games = normalizeReplay(await response.json());
      if (controller.signal.aborted || request.current !== controller) return;
      if (!games.some(g => g.steps.length)) throw new Error('此回放暂时没有动作快照；本地日志补全后会自动更新。');
      const store = useReplayStore.getState(); store.setMatches(games);
      loadedRevision.current = { id, revision };
      if (gameNumber != null) { const i = games.findIndex(g => g.gameNumber === gameNumber); if (i >= 0) store.selectMatch(i); }
      if (anchor && !store.goToAnchor(anchor)) setAnchorError(`本局没有锚点 ${anchor}。`);
      const url = new URL(location.href); url.searchParams.set('match', games[0].matchId); historyReplace(url);
    } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (request.current === controller) { navigating.current = false; if (!controller.signal.aborted) setLoading(false); } }
  }, [account]);

  useEffect(() => {
    request.current?.abort(); loadedRevision.current = null; historyEntries.current = [];
    useReplayStore.getState().setMatches([]); setHistory([]); setDraftRuns([]); setLoading(true); setError('');
  }, [account]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let initial = true;
    let draftRefreshRunning = false;
    async function refreshDraftRuns() {
      if (draftRefreshRunning || controller.signal.aborted) return;
      draftRefreshRunning = true;
      try {
        const response = await fetch(`/api/draft-runs?account=${encodeURIComponent(account)}`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
        if (!response.ok) throw new Error('轮抽记录暂时无法读取，将自动重试。');
        const runs = normalizeDraftRuns(await response.json());
        if (!controller.signal.aborted) { setDraftRuns(runs); setDraftError(''); }
      } catch {
        if (!controller.signal.aborted) setDraftError('轮抽记录暂时无法更新；已显示的轮抽数据可能不是最新。');
      } finally { draftRefreshRunning = false; }
    }
    async function refresh() {
      try {
        if (!initial && document.visibilityState === 'hidden') return;
        const response = await fetch(`/api/matches?account=${encodeURIComponent(account)}`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`无法读取比赛记录（${response.status}）。会自动重试。`);
        const entries = normalizeHistory(await response.json());
        const accountResponse = await fetch('/api/accounts', { cache: 'no-store', signal: controller.signal });
        if (accountResponse.ok) {
          const catalog = await accountResponse.json();
          if (!controller.signal.aborted && Array.isArray(catalog.accounts)) {
            setAccounts(catalog.accounts.filter((a: { account_key?: string; label?: string }) => typeof a.account_key === 'string' && /^[a-f0-9]{64}$/.test(a.account_key) && typeof a.label === 'string'));
            if (!accountChosen.current && /^[a-f0-9]{64}$/.test(catalog.active_account ?? '')) {
              accountChosen.current = true; setAccount(catalog.active_account); return;
            }
          }
        }
        void refreshDraftRuns(); // A draft-sidecar failure must never block ordinary replay history.
        if (controller.signal.aborted) return;
        if (JSON.stringify(historyEntries.current) !== JSON.stringify(entries)) {
          historyEntries.current = entries; setHistory(entries);
        }
        initial = false;
        const current = useReplayStore.getState().currentMatch();
        if (navigating.current) return;
        if (!current) {
          if (!entries.length) { setLoading(false); setError('尚无回放。正在自动观察本机日志，完成一局后会更新。'); return; }
          const params = new URLSearchParams(location.search), requested = params.get('match');
          const id = entries.some(entry => entry.id === requested) ? requested! : entries[0].id;
          await loadMatch(id, params.get('anchor') ?? undefined, params.has('game') ? Number(params.get('game')) : undefined);
          return;
        }
        const entry = entries.find(value => value.id === current.matchId);
        if (!entry || loadedRevision.current?.id !== current.matchId || entry.revision === loadedRevision.current.revision) return;
        const navigation = request.current;
        const replay = await fetch(`/api/matches/${encodeURIComponent(current.matchId)}?account=${encodeURIComponent(account)}`, { cache: 'no-store', signal: controller.signal });
        if (!replay.ok) return; // Keep a readable current replay during retries.
        const games = normalizeReplay(await replay.json());
        if (controller.signal.aborted || navigating.current || request.current !== navigation || useReplayStore.getState().currentMatch()?.matchId !== current.matchId) return;
        if (useReplayStore.getState().refreshMatches(games)) loadedRevision.current = { id: current.matchId, revision: entry.revision };
      } catch (err) {
        if (!controller.signal.aborted && !useReplayStore.getState().currentMatch()) { setLoading(false); setError(err instanceof Error ? err.message : String(err)); }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); }, 3000);
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); request.current?.abort(); };
  }, [loadMatch, account]);

  useEffect(() => {
    function dismissHistory(event: MouseEvent) {
      const picker = historyPicker.current;
      if (picker?.open && event.target instanceof Node && !picker.contains(event.target)) picker.open = false;
    }
    document.addEventListener('click', dismissHistory, true);
    return () => document.removeEventListener('click', dismissHistory, true);
  }, []);

  useLayoutEffect(() => { useHoverStore.getState().setHovered(null); }, [step, s.currentMatchIndex, match?.matchId, s.viewBefore]);
  useEffect(() => {
    if (!match || !step || loading) return;
    const url = new URL(location.href); url.searchParams.set('match', match.matchId); url.searchParams.set('anchor', step.anchor); url.searchParams.set('game', String(match.gameNumber)); historyReplace(url);
  }, [match?.matchId, match?.gameNumber, step?.anchor, loading]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey || (event.target instanceof HTMLElement && (event.target.matches('input,textarea,select') || event.target.isContentEditable)) || document.querySelector('dialog[open]')) return;
      const store = useReplayStore.getState();
      if (!store.currentMatch()) return;
      switch (event.key) {
        case ' ': if (event.target instanceof HTMLElement && event.target.closest('button')) return; event.preventDefault(); store.togglePlay(); break;
        case 'ArrowRight': event.preventDefault(); store.pause(); event.shiftKey ? store.nextTurn() : store.stepForward(); break;
        case 'ArrowLeft': event.preventDefault(); store.pause(); event.shiftKey ? store.previousTurn() : store.stepBackward(); break;
        case 'Home': event.preventDefault(); store.goToFirst(); break;
        case 'End': event.preventDefault(); store.goToLast(); break;
      }
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);

  function jump(anchor: string) { s.pause(); if (!s.goToAnchor(anchor)) setAnchorError(`没有找到锚点 ${anchor}。`); else setAnchorError(''); }
  const contextUrl = match && step ? `/api/matches/${encodeURIComponent(match.matchId)}/context?${new URLSearchParams({
    game: String(match.gameNumber), anchor: step.anchor, boundary: actualBefore ? 'before' : 'after',
  })}` : undefined;
  const notes = match?.steps.flatMap(p => p.coachNotes.map(note => ({ ...note, anchor: note.anchor || p.anchor }))) ?? [];
  const warnings = integrityMessages([...(match?.warnings ?? []), ...(step?.warnings ?? [])]);

  return <div className={`app-shell ${analysis ? 'analysis-mode' : 'replay-mode'}`}>
    <a className="skip-link" href="#replay-controls">跳至回放控制</a>
    <header className="app-header">
      <h1>MTGA <span>Replay Coach</span></h1>
      {publishedSource && <span role="status" className="published-source" title={`来源哈希 ${publishedSource.content_hash}`}>历史发布源 · {publishedSource.revision.slice(0, 7)} · 只读（独立于本地归档）</span>}
      {!publishedSource && <label className="account-picker">游戏账号 <select aria-label="游戏账号" value={account} onChange={event => { accountChosen.current = true; setAccount(event.target.value); }}>
        <option value="unassigned">未分类旧记录 / 待识别</option>
        {accounts.map(item => <option key={item.account_key} value={item.account_key}>{item.label} · {item.account_key.slice(0, 6)}</option>)}
      </select></label>}
      <details className="history-picker" ref={historyPicker}><summary>比赛记录 <span>⌄</span></summary><div className="history-menu">
        {draftError && <p role="status" className="draft-run-warning">{draftError}</p>}
        {draftRuns.length > 0 && <section className="draft-runs"><h2>轮抽记录</h2>{draftRuns.map(run => <details className="draft-run" key={run.run_id}>
          <summary><span className="history-row-top"><span className="history-date">{when(run.started_at ?? '')}</span><span className="history-event" title={run.event}>{formatEventName(run.event)}</span></span>
            <span className="history-row-bottom"><span className={'draft-run-status ' + run.status} title={draftRunScoreMessage(run)}>{run.capture_source ? '选牌已保存' : draftRunStatusLabel(run)}</span>
              <span className="history-row-result"><span className="draft-run-colors" title="按最后一场归档主牌组的地牌颜色归类">{run.colors_complete ? (run.colors.map(color => COLOR_LABELS[color] ?? color).join('') || '无色') : '颜色未知'}</span>
                <strong>{run.capture_source ? '尚未关联比赛' : <>{run.replay_wins}胜{run.replay_losses}负</>}</strong></span>
            </span>
          </summary>
          {run.capture_source ? <p className="draft-run-warning">来自 17Lands 本地记录；分段与比赛归属待核验。时间为工具记录时间，牌池仅累计实际观察到的选择。</p> : draftRunScoreMessage(run) && <p className="draft-run-warning">{draftRunScoreMessage(run)}</p>}
          {run.picks.length > 0 && <details className="draft-picks"><summary>逐手记录 · {run.picks.length} 手 · {run.picks.filter(pick => pick.complete).length} 手连续有据</summary>
            <ol>{run.picks.map(pick => <li key={pick.pack_number + '-' + pick.pick_number} className={pick.complete ? 'complete' : 'incomplete'}>
              <strong>Pack {pick.pack_number} · Pick {pick.pick_number}</strong><time>{when(pick.picked_at ?? '')}</time>
              <p>选择：{pick.selected?.name ?? '缺少选择记录'}</p>
              <details><summary>候选 {pick.candidates.length} 张 · 牌池 {pick.pool_before.length} → {pick.pool_after.length} 张</summary>
                <p>候选：{pick.candidates.length ? pick.candidates.map(card => card.name).join('、') : '缺少候选包记录'}</p>
                <p>选择前：{pick.pool_before.map(card => card.name).join('、') || '空'}</p>
                <p>选择后：{pick.pool_after.map(card => card.name).join('、') || '空'}</p>
                {!pick.complete && <p>记录不完整：{pick.missing.join('、') || '源记录字段不足'}</p>}
              </details>
            </li>)}</ol>
          </details>}
          {run.card_pool.length > 0 && <details className="draft-pool"><summary>赛事牌池快照 · {run.card_pool.length} 张</summary>
            <ol>{run.card_pool.map((card, index) => <li key={card.arena_id + '-' + index}>{card.name}</li>)}</ol>
          </details>}
          <div className="draft-run-matches">{run.matches.map(item => <button type="button" className="history-item" key={item.id}
            aria-label={when(item.started_at) + ' · ' + (item.result ?? '结果未知')}
            onClick={() => { loadMatch(item.id); if (historyPicker.current) historyPicker.current.open = false; }}>
            <span className="history-row-top"><span className="history-date">{when(item.started_at)}</span><span className="history-event" title={run.event}>{formatEventName(run.event)}</span></span>
            <span className="history-row-bottom"><span className="history-row-context">{item.game_count ? item.game_count + ' 局' : '局数未知'}</span>
              <strong>{item.result === 'Win' ? '胜' : item.result === 'Loss' ? '负' : '结果未知'}</strong></span></button>)}
          </div>
        </details>)}</section>}
        <details className="all-matches"><summary>全部比赛 · {history.length}</summary>
          {history.map(item => <button type="button" key={item.id} aria-label={when(item.startedAt) + ' · ' + formatEventName(item.event) + ' · ' + (item.result === 'Win' ? '胜' : item.result === 'Loss' ? '负' : item.result)} className={'history-item ' + (match?.matchId === item.id ? 'selected' : '')} onClick={() => { loadMatch(item.id); if (historyPicker.current) historyPicker.current.open = false; }}>
            <span className="history-row-top"><span className="history-date">{when(item.startedAt)}</span><span className="history-event" title={item.event}>{formatEventName(item.event)}</span></span>
            <span className="history-row-bottom"><span className="history-row-context">{item.gameCount ? item.gameCount + ' 局' : '局数未知'}</span><strong>{item.result === 'Win' ? '胜' : item.result === 'Loss' ? '负' : item.result}</strong></span>
          </button>)}
        </details>
      </div></details>
      {match && <span className="match-caption">{when(match.startedAt)} · {formatEventName(match.eventName)}</span>}
      {s.matches.length>1 && <select aria-label="选择单局" value={s.currentMatchIndex} onChange={e=>s.selectMatch(Number(e.target.value))}>{s.matches.map((g,i)=><option key={g.gameNumber} value={i}>第 {g.gameNumber} 局</option>)}</select>}
      <ReplaySyncButton /><CollectionUpdateButton />
      {match && step && !error && !loading && <ReplayReviewCoach match={match} currentStepIndex={s.currentStepIndex} viewBefore={actualBefore}
        onJump={(anchor, boundary) => { jump(anchor); s.setViewBefore(boundary === 'before'); }} />}
      <div className="mode-switch" aria-label="查看模式"><button type="button" aria-pressed={!analysis} onClick={()=>{setAnalysis(false);s.setViewBefore(false);}}>回放</button><button type="button" aria-pressed={analysis} onClick={()=>{s.pause();setAnalysis(true);}}>分析</button></div>
    </header>
    <div className="app-workspace">
      {analysis && <aside className="analysis-drawer" aria-label="完整时间线与分析">
        <header className="drawer-header"><h2>比赛分析</h2><button type="button" aria-label="关闭分析" onClick={()=>{setAnalysis(false);s.setViewBefore(false);}}>×</button></header>
        <section className="analysis-tools"><div className="boundary-buttons" aria-label="局面边界"><button type="button" className={actualBefore ? 'selected' : ''} disabled={!step?.beforeGameState} aria-pressed={actualBefore} onClick={()=>s.setViewBefore(true)}>动作前</button><button type="button" className={!actualBefore ? 'selected' : ''} aria-pressed={!actualBefore} onClick={()=>s.setViewBefore(false)}>动作后</button></div>
          <p>{step?.anchor} · {actualBefore ? '该 Arena 消息之前' : '该 Arena 消息之后'}</p>
          {step?.groupedFrame && <p>同一消息中的多个动作共享局面，未推测中间状态。</p>}
          <details className="coach-notes"><summary>教练笔记 · {notes.length}</summary>{notes.length ? notes.map((note,i)=><button key={i} type="button" className="coach-note" onClick={()=>jump(note.anchor)}><b>{note.title ?? '教练笔记'} <small>{note.anchor}</small></b><span>{note.text}</span></button>) : <p>暂无笔记。导入的笔记可直接跳到对应动作。</p>}</details>
          <div className="warnings-panel"><button type="button" onClick={()=>setShowWarnings(!showWarnings)} aria-expanded={showWarnings}>数据完整性 · {warnings.length ? `${warnings.length} 项限制` : '未发现额外限制'}</button>{showWarnings && (warnings.length ? <ul>{warnings.map((w,i)=><li key={i}>{w.chinese}{w.original !== w.chinese && <details><summary>{w.translated ? '查看原文' : '未归类说明原文'}</summary><code>{w.original}</code></details>}</li>)}</ul> : <p>这不代表日志记录了所有合法行动或优先权窗口。</p>)}</div>
          <details className="advanced-tools"><summary>高级工具</summary>
          <form onSubmit={e=>{e.preventDefault();jump(anchorInput);}}><input aria-label="调试：回放锚点" placeholder="T12-A19" value={anchorInput} onChange={e=>setAnchorInput(e.target.value)} /><button type="submit">定位</button></form>
          {anchorError && <p role="status">{anchorError}</p>}
          <a className="context-download" href={contextUrl} download>下载 Coach Context</a>
          </details>
        </section>
        {match && <GameLog match={match} currentStepIndex={s.currentStepIndex} analysis />}
      </aside>}
      <div className="replay-content">
        {error ? <div className="error-state" role="alert"><h2>回放不可用</h2><p>{error}</p><button type="button" className="standard-button" onClick={()=>location.reload()}>重试</button></div> : loading ? <div className="loading-state" role="status">正在读取本机回放…</div> : match && step && <>
          <GameBoard match={match} step={step} viewBefore={actualBefore} analysis={analysis} />
        </>}
      </div>
    </div>
    {match && step && !error && <div id="replay-controls"><ReplayControls analysis={analysis} /></div>}
  </div>;
}
function historyReplace(url: URL) { window.history.replaceState(null, '', url); }
