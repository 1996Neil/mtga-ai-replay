import { useReplayStore } from '../store/replayStore';
import { phaseTextZh } from '../lib/display';
export function TurnSlider({ analysis = false }: { analysis?: boolean }) {
  const { currentStepIndex, goToStep, currentMatch, pause, viewBefore } = useReplayStore();
  const steps = currentMatch()?.steps ?? [];
  if (!steps.length) return null;
  const ticks: number[] = []; let previousTurn = -1;
  steps.forEach((step, index) => { if (step.turnNumber !== previousTurn) { ticks.push(index); previousTurn = step.turnNumber; } });
  const current = steps[currentStepIndex];
  const shown = viewBefore && current?.beforeGameState ? current.beforeGameState.turnInfo : current?.gameState.turnInfo;
  const position = shown ? `第 ${shown.turnNumber} 回合，${phaseTextZh(shown.phase, shown.step)}${analysis ? `，${current.anchor}` : ''}` : '回放位置';
  return <div className="turn-scrubber">
    <span className="scrubber-end-label">开局</span>
    <input aria-label="回放进度" aria-valuetext={position} type="range" min={0} max={steps.length - 1} value={currentStepIndex} onChange={e => { pause(); goToStep(Number(e.target.value)); }} list="turn-ticks" />
    <datalist id="turn-ticks">{ticks.map(index => <option key={index} value={index} label={`第 ${steps[index].turnNumber} 回合`} />)}</datalist>
    <span className="scrubber-end-label">终局</span>
  </div>;
}
