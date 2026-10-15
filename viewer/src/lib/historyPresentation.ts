/** Presentation only: raw timestamps and event IDs remain unchanged. */
export function formatMatchTime(value: string, timeZone?: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '时间未记录';
  const parts = new Intl.DateTimeFormat('en-GB', { year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '';
  return `${part('year')}/${part('month')}/${part('day')} ${part('hour')}:${part('minute')}`;
}

export function formatEventName(value: string): string {
  return value.replace(/_\d{8}$/, '');
}
import type { DraftRun } from '../types/game';


type DraftScore = Pick<DraftRun, 'status' | 'current_module' | 'score_verified' | 'course_wins' | 'course_losses' | 'replay_wins' | 'replay_losses' | 'matches'>;

/** User-selected display default only; never changes saved course counters or verification. */
export function usesCompletedZeroWinDefault(run: DraftScore): boolean {
  const ended = run.status === 'completed' || /complete|finish|claim|reward|end/i.test(run.current_module ?? '');
  return ended && run.course_wins === null && run.course_losses === 3 &&
    run.replay_wins === 0 && run.replay_losses === 3 && run.matches.length === 3 &&
    run.matches.every(match => match.result === 'Loss');
}

export function draftRunStatusLabel(run: DraftScore): string {
  const ended = run.status === 'completed' || /complete|finish|claim|reward|end/i.test(run.current_module ?? '');
  const status = ended ? '已结束' : run.status === 'in_progress' ? '进行中' : '状态待确认';
  const missing = run.course_wins === null ? '胜场总数未知' : run.course_losses === null ? '负场总数未知' : '战绩待核对';
  return status + (run.score_verified || usesCompletedZeroWinDefault(run) ? '' : ' · ' + missing);
}

export function draftRunScoreMessage(run: DraftScore): string {
  if (run.score_verified || usesCompletedZeroWinDefault(run)) return '';
  const counts = `结算记录：${run.course_wins ?? '未知'}胜${run.course_losses ?? '未知'}负；归档回放：${run.replay_wins}胜${run.replay_losses}负。`;
  if (run.course_wins == null || run.course_losses == null) return counts + '结算记录缺少胜负计数，整轮总战绩未知，无法排除归档漏场。';
  if (run.matches.some(match => !['Win', 'Loss', 'Draw'].includes(match.result ?? ''))) return counts + '归档回放中存在结果未知的比赛，暂时无法核对。';
  return counts + '两者不一致，轮抽归属及计数来源需要核查；列表暂按归档回放汇总。';
}
