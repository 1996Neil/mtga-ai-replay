// Turn chapters reuse canonical events; localization is only a display layer.
import { useEffect, useRef } from 'react';
import type { ParsedMatch, ReplayStep } from '../types/game';
import { useReplayStore } from '../store/replayStore';
import { useCardCacheStore } from '../store/cardCacheStore';
import { actorLabelZh, describeEventZh, phaseLabelZh, phaseTextZh } from '../lib/display';
import { observationGroup } from '../lib/observationGroups';

interface Props { match: ParsedMatch; currentStepIndex: number; analysis?: boolean; }
function jump(index: number) { const store = useReplayStore.getState(); store.pause(); store.goToStep(index); }
const eventLabel = (step: ReplayStep, names: Parameters<typeof describeEventZh>[1]) => step.event ? describeEventZh(step.event, names) : phaseTextZh(step.phase, step.step);

export function GameLog({ match, currentStepIndex, analysis = true }: Props) {
  const current = useRef<HTMLButtonElement>(null), names = useCardCacheStore(s => s.cards);
  useEffect(() => { current.current?.scrollIntoView({ block: 'nearest' }); }, [currentStepIndex]);
  return <section className="game-log flex flex-col min-h-0 flex-1" aria-label="完整时间线">
    <header className="timeline-heading"><h2>完整时间线</h2>{analysis && <span>{match.steps.length} 个动作</span>}</header>
    <div className="timeline-scroll overflow-y-auto flex-1 min-h-0">
      {match.steps.map((step, index) => {
        const previous = match.steps[index - 1], newTurn = !previous || step.turnNumber !== previous.turnNumber;
        const label = eventLabel(step, names);
        return <div key={step.anchor}>
          {newTurn && <h3 className="timeline-turn">{step.turnNumber === 0 ? '起手与调度' : `第 ${step.turnNumber} 回合 · ${actorLabelZh(step.gameState.turnInfo.activePlayer)}`}</h3>}
          {(newTurn || step.phase !== previous.phase) && <h4 className="timeline-phase">{phaseLabelZh(step.phase)}</h4>}
          {step.groupedFrame && (!previous || previous.stateId !== step.stateId) &&
            <p className="timeline-observation">同次结算 · {observationGroup(match.steps, index).steps.length} 项变化 · 共享结算后局面</p>}
          <button type="button" ref={index === currentStepIndex ? current : undefined} className={`timeline-event ${index === currentStepIndex ? 'current' : ''}`} aria-current={index === currentStepIndex ? 'step' : undefined} onClick={() => jump(index)} title={analysis && step.groupedFrame ? '这些动作来自同一条游戏状态消息，共享观测后的局面。' : label}>
            <span className="timeline-action-number">{step.turnNumber}:{String(step.actionNumber || index + 1).padStart(2, '0')}</span>
            <span className="timeline-label">{label}</span>
            {analysis && <span className="timeline-anchor">{step.anchor}</span>}
            {analysis && !!step.coachNotes.length && <span className="coach-indicator">教练笔记</span>}
          </button>
        </div>;
      })}
    </div>
  </section>;
}

export function NearbyActions({ match, currentStepIndex, analysis = false }: Props) {
  const names = useCardCacheStore(s => s.cards), current = match.steps[currentStepIndex];
  const before = useReplayStore(s => s.viewBefore) && Boolean(current?.beforeGameState);
  if (!current) return null;
  const first = Math.max(0, currentStepIndex - 2), last = Math.min(match.steps.length, currentStepIndex + 3);
  const group = observationGroup(match.steps, currentStepIndex);
  return <section className="nearby-actions" aria-label="当前动作附近">
    {group.steps.length > 1 && <details className="observation-details" key={`${current.stateId}:${before}`}>
      <summary>同次结算 · {group.steps.length} 项变化 · 当前显示结算{before ? '前' : '后'}局面</summary>
      {before ? <p>此次结算的结果将在结算后局面中显示。</p> :
        <ol>{group.steps.map((step, index) => <li key={step.anchor}>
          <button type="button" aria-current={group.start + index === currentStepIndex ? 'step' : undefined} onClick={() => jump(group.start + index)}>{eventLabel(step, names)}</button>
        </li>)}</ol>}
    </details>}
    <div className="nearby-list">{match.steps.slice(first, last).map((step, offset) => {
      const index = first + offset, selected = index === currentStepIndex;
      return <button type="button" key={step.anchor} className={`nearby-action ${selected ? 'current' : ''}`} aria-current={selected ? 'step' : undefined} onClick={() => jump(index)}>
        <span className="nearby-position" aria-hidden="true">{selected ? '●' : index < currentStepIndex ? '←' : '→'}</span>
        <span className="nearby-label">{before && (index >= currentStepIndex || step.stateId === current.stateId) ? (selected ? '动作前局面' : '后续动作') : eventLabel(step, names)}</span>{analysis && <span className="timeline-anchor">{step.anchor}</span>}
      </button>;
    })}</div>
  </section>;
}
