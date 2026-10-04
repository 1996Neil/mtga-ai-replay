// Data-loading shell replaces the upstream upload worker. It consumes the local canonical API.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useReplayStore } from './store/replayStore';
import { useHoverStore } from './store/hoverStore';
import { useReplayEngine } from './hooks/useReplayEngine';
import { normalizeHistory, normalizeReplay } from './lib/canonicalAdapter';
import type { HistoryMatch } from './types/game';
import { GameBoard } from './components/GameBoard';
import { GameLog, NearbyActions } from './components/GameLog';
import { ReplayControls } from './components/ReplayControls';
import { ReplaySyncButton } from './components/ReplaySyncButton';
import { LiveCoachPanel } from './components/LiveCoachPanel';

function when(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '时间未记录' : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date); }
export function App() {
  const [history, setHistory] = useState<HistoryMatch[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [anchorInput, setAnchorInput] = useState(''), [anchorError, setAnchorError] = useState('');
  const [showWarnings, setShowWarnings] = useState(false);
  const [analysis, setAnalysis] = useState(false);
  const s = useReplayStore(), match = s.currentMatch(), step = s.currentStep();
  const actualBefore = s.viewBefore && Boolean(step?.beforeGameState);
  const request = useRef<AbortController | null>(null);
  const historyEntries = useRef<HistoryMatch[]>([]);
  useReplayEngine();

  const loadMatch = useCallback(async (id: string, anchor?: string, gameNumber?: number) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(''); setAnchorError('');
    useReplayStore.getState().pause();
    try {
      const response = await fetch(`/api/matches/${encodeURIComponent(id)}`, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`无法加载回放（${response.status}），请重新运行 mtga-gpt-replay latest。`);
      const games = normalizeReplay(await response.json());
      if (controller.signal.aborted || request.current !== controller) return;
      if (!games.some(g => g.steps.length)) throw new Error('此回放没有动作快照，请运行 mtga-gpt-replay latest 重新导出。');
      const store = useReplayStore.getState(); store.setMatches(games);
      if (gameNumber != null) { const i = games.findIndex(g => g.gameNumber === gameNumber); if (i >= 0) store.selectMatch(i); }
      if (anchor && !store.goToAnchor(anchor)) setAnchorError(`本局没有锚点 ${anchor}。`);
      const url = new URL(location.href); url.searchParams.set('match', games[0].matchId); historyReplace(url);
    } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/matches', { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`无法读取比赛记录（${response.status}）。`);
      const entries = normalizeHistory(await response.json()); historyEntries.current = entries; setHistory(entries);
      if (!entries.length) { setLoading(false); setError('尚无 Jump In 回放。打一局后运行 mtga-gpt-replay latest。'); return; }
      const params = new URLSearchParams(location.search);
      loadMatch(params.get('match') || entries[0].id, params.get('anchor') ?? undefined, params.has('game') ? Number(params.get('game')) : undefined);
    }).catch(err => { if (!controller.signal.aborted) { setLoading(false); setError(err.message); } });
    return () => { controller.abort(); request.current?.abort(); };
  }, [loadMatch]);

  const refreshHistory = useCallback(async () => {
    const response = await fetch('/api/matches', { cache: 'no-store' });
    if (!response.ok) throw new Error('同步已结束，但比赛记录暂时无法刷新。请重试。');
    const entries = normalizeHistory(await response.json()), previous = new Set(historyEntries.current.map(item => item.id));
    historyEntries.current = entries; setHistory(entries);
    if (!useReplayStore.getState().currentMatch() && entries.length) await loadMatch(entries[0].id);
    return entries.filter(item => !previous.has(item.id)).length;
  }, [loadMatch]);

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
  const warnings = [...(match?.warnings ?? []), ...(step?.warnings ?? [])];

  return <div className={`app-shell ${analysis ? 'analysis-mode' : 'replay-mode'}`}>
    <a className="skip-link" href="#replay-controls">跳至回放控制</a>
    <header className="app-header">
      <h1>MTGA <span>Replay Coach</span></h1>
      <details className="history-picker"><summary>比赛记录 <span>⌄</span></summary><div className="history-menu">
        {history.map(item => <button type="button" key={item.id} aria-label={`${when(item.startedAt)} · ${item.event} · ${item.result==='Win' ? '胜' : item.result==='Loss' ? '负' : item.result}`} className={`history-item ${match?.matchId===item.id ? 'selected' : ''}`} onClick={e=>{loadMatch(item.id); e.currentTarget.closest('details')?.removeAttribute('open');}}>
          <span>{when(item.startedAt)}</span><span>{item.event.includes('Jump') ? 'Jump In' : item.event}</span><strong>{item.result==='Win' ? '胜' : item.result==='Loss' ? '负' : item.result}</strong></button>)}
      </div></details>
      {match && <span className="match-caption">{when(match.startedAt)} · Jump In</span>}
      {s.matches.length>1 && <select aria-label="选择单局" value={s.currentMatchIndex} onChange={e=>s.selectMatch(Number(e.target.value))}>{s.matches.map((g,i)=><option key={g.gameNumber} value={i}>第 {g.gameNumber} 局</option>)}</select>}
      <ReplaySyncButton refreshHistory={refreshHistory} />
      <LiveCoachPanel view={!loading && !error && match && step ? { match_id: match.matchId, game_number: match.gameNumber,
        anchor: step.anchor, boundary: actualBefore ? 'before' : 'after' } : null} />
      <div className="mode-switch" aria-label="查看模式"><button type="button" aria-pressed={!analysis} onClick={()=>{setAnalysis(false);s.setViewBefore(false);}}>回放</button><button type="button" aria-pressed={analysis} onClick={()=>{s.pause();setAnalysis(true);}}>分析</button></div>
    </header>
    <div className="app-workspace">
      {analysis && <aside className="analysis-drawer" aria-label="完整时间线与分析">
        <header className="drawer-header"><h2>比赛分析</h2><button type="button" aria-label="关闭分析" onClick={()=>{setAnalysis(false);s.setViewBefore(false);}}>×</button></header>
        <section className="analysis-tools"><div className="boundary-buttons" aria-label="局面边界"><button type="button" className={actualBefore ? 'selected' : ''} disabled={!step?.beforeGameState} aria-pressed={actualBefore} onClick={()=>s.setViewBefore(true)}>动作前</button><button type="button" className={!actualBefore ? 'selected' : ''} aria-pressed={!actualBefore} onClick={()=>s.setViewBefore(false)}>动作后</button></div>
          <p>{step?.anchor} · {actualBefore ? '该 Arena 消息之前' : '该 Arena 消息之后'}</p>
          {step?.groupedFrame && <p>同一消息中的多个动作共享局面，未推测中间状态。</p>}
          <form onSubmit={e=>{e.preventDefault();jump(anchorInput);}}><input aria-label="回放锚点" placeholder="T12-A19" value={anchorInput} onChange={e=>setAnchorInput(e.target.value)} /><button type="submit">定位</button></form>
          {anchorError && <p role="status">{anchorError}</p>}
          <a className="context-download" href={contextUrl} download>下载 Coach Context</a>
          <details className="coach-notes"><summary>教练笔记 · {notes.length}</summary>{notes.length ? notes.map((note,i)=><button key={i} type="button" className="coach-note" onClick={()=>jump(note.anchor)}><b>{note.title ?? '教练笔记'} <small>{note.anchor}</small></b><span>{note.text}</span></button>) : <p>暂无笔记。导入的笔记可直接跳到对应动作。</p>}</details>
          {!!warnings.length && <div className="warnings-panel"><button type="button" onClick={()=>setShowWarnings(!showWarnings)} aria-expanded={showWarnings}>重建说明 · {warnings.length}</button>{showWarnings && <ul>{warnings.map((w,i)=><li key={i}>{w}</li>)}</ul>}</div>}
        </section>
        {match && <GameLog match={match} currentStepIndex={s.currentStepIndex} analysis />}
      </aside>}
      <div className="replay-content">
        {error ? <div className="error-state" role="alert"><h2>回放不可用</h2><p>{error}</p><button type="button" className="standard-button" onClick={()=>location.reload()}>重试</button></div> : loading ? <div className="loading-state" role="status">正在读取本机回放…</div> : match && step && <>
          <GameBoard match={match} step={step} viewBefore={actualBefore} analysis={analysis} />
          <NearbyActions match={match} currentStepIndex={s.currentStepIndex} analysis={analysis} onOpenTimeline={()=>{s.pause();setAnalysis(true);}} />
        </>}
      </div>
    </div>
    {match && step && !error && <div id="replay-controls"><ReplayControls analysis={analysis} /></div>}
  </div>;
}
function historyReplace(url: URL) { window.history.replaceState(null, '', url); }
