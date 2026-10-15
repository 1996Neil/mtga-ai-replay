import { phaseTextZh, translatePhaseText } from '../lib/display';
interface Props { label?: string; phase?: string; step?: string; turn?: number; }
export function PhaseIndicator({ label, phase, step, turn }: Props) {
  const text = phase ? `${turn != null ? `第 ${turn} 回合 · ` : ''}${phaseTextZh(phase, step)}` : translatePhaseText(label ?? '未记录阶段');
  const combat = phase === 'Phase_Combat' || /Combat|战斗/.test(label ?? '');
  return <span className={`phase-indicator ${combat ? 'combat-phase' : ''}`}>{text}</span>;
}
