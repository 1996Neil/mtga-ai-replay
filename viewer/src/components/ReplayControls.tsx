// Basic transport stays visible; opening/ending and speed options are secondary.
import { useReplayStore } from '../store/replayStore';
import { NearbyActions } from './GameLog';
import { actorLabelZh, phaseTextZh } from '../lib/display';
import { TurnSlider } from './TurnSlider';
const SPEEDS = [0.5, 1, 2, 4];
export function ReplayControls({ analysis = false }: { analysis?: boolean }) {
  const s = useReplayStore(), match = s.currentMatch(), step = s.currentStep();
  const shown = s.viewBefore && step?.beforeGameState ? step.beforeGameState.turnInfo : step?.gameState.turnInfo;
  const total = match?.steps.length ?? 0, first = s.currentStepIndex <= 0, last = s.currentStepIndex >= total - 1;
  return <footer className="replay-controls" aria-label="回放控制">
    <div className="replay-position"><div className="replay-position-title">{shown ? `${shown.turnNumber === 0 ? '起手与调度' : `第 ${shown.turnNumber} 回合 · ${actorLabelZh(shown.activePlayer)}`} · ${phaseTextZh(shown.phase, shown.step)}` : '正在读取回放'}</div>
      {match && <NearbyActions match={match} currentStepIndex={s.currentStepIndex} analysis={analysis} />}
      {analysis && <span className="replay-technical-position">{step?.anchor} · {s.currentStepIndex + 1} / {total} 个动作</span>}</div>
    <div className="control-button-row">
      <button className="standard-button" type="button" onClick={s.previousTurn} disabled={first} title="Shift + 左方向键">上一回合</button>
      <button className="standard-button" type="button" onClick={s.stepBackward} disabled={first} title="左方向键">上一步</button>
      <button className="standard-button play-button" type="button" onClick={s.togglePlay} aria-label={s.isPlaying ? '暂停' : '播放'} title="空格键">{s.isPlaying ? 'Ⅱ 暂停' : '▶ 播放'}</button>
      <button className="standard-button" type="button" onClick={s.stepForward} disabled={last} title="右方向键">下一步</button>
      <button className="standard-button" type="button" onClick={s.nextTurn} disabled={last} title="Shift + 右方向键">下一回合</button>
      <details className="playback-options"><summary aria-label="回放速度与更多控制">{s.playbackSpeed}× <span aria-hidden="true">⌄</span></summary>
        <div className="playback-options-menu"><div className="playback-jump-buttons"><button type="button" onClick={s.goToFirst} disabled={first} title="Home 键">开局</button><button type="button" onClick={s.goToLast} disabled={last} title="End 键">终局</button></div>
          <div className="playback-speed-buttons" aria-label="播放速度">{SPEEDS.map(speed => <button key={speed} type="button" onClick={() => s.setSpeed(speed)} aria-pressed={s.playbackSpeed === speed} className={`speed-button ${s.playbackSpeed === speed ? 'selected' : ''}`}>{speed}×</button>)}</div></div>
      </details>
    </div>
    <TurnSlider analysis={analysis} />
  </footer>;
}
