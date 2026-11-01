import type { DraftPick, DraftRun } from '../types/game.ts';

export type DraftCard = DraftPick['candidates'][number];

export function draftBindingLabel(run: DraftRun): string {
  if (!run.capture_source) return `归档 ${run.replay_wins}胜 ${run.replay_losses}负`;
  if (run.binding === 'matched_pool') return run.binding_account_status === 'conflict'
    ? '对战已关联 · 账号待核对' : run.binding_account_status === 'unknown'
      ? run.ownership_corrected
        ? `已关联 · 账号由对战核实 · ${run.score_verified ? '' : '归档 '}${run.replay_wins}胜 ${run.replay_losses}负`
        : `已关联 · 账号待识别 · ${run.score_verified ? '' : '归档 '}${run.replay_wins}胜 ${run.replay_losses}负`
      : `已关联 · ${run.score_verified ? '' : '归档 '}${run.replay_wins}胜 ${run.replay_losses}负`;
  return ({
    incomplete_picks: '选牌不完整 · 暂不能核对',
    missing_course: '暂未找到对应赛事',
    ambiguous_courses: '多个赛事吻合 · 待核对',
    missing_matches: '赛事暂无归档对战',
    evidence_unavailable: '关联资料暂不可用',
    awaiting_match_upload: '等待对战上传',
  } as Record<string, string>)[run.binding_reason ?? ''] ?? '比赛待关联';
}

/** Sources arrive in separate batches. Compare instants, including UTC offsets. */
export function visibleDraftRuns(runs: DraftRun[]): DraftRun[] {
  const timestamp = (run: DraftRun) => {
    const value = Date.parse(run.started_at ?? '');
    return Number.isFinite(value) ? value : -Infinity;
  };
  return runs.filter(run => orderedDraftPicks(run.picks).length > 0).sort((a, b) => {
    const left = timestamp(a), right = timestamp(b);
    return left === right ? a.run_id.localeCompare(b.run_id) : left > right ? -1 : 1;
  });
}

export const draftPickKey = (pick: Pick<DraftPick, 'pack_number' | 'pick_number'>) =>
  `${pick.pack_number}-${pick.pick_number}`;

/** Navigate observed picks only. Gaps remain visible in the pack/pick labels. */
export function orderedDraftPicks(picks: DraftPick[]): DraftPick[] {
  return picks.filter(p => Number.isSafeInteger(p.pack_number) && p.pack_number > 0 &&
    Number.isSafeInteger(p.pick_number) && p.pick_number > 0)
    .slice().sort((a, b) => a.pack_number - b.pack_number || a.pick_number - b.pick_number);
}

export function draftPickIndex(picks: DraftPick[], key: string): number {
  return Math.max(0, picks.findIndex(p => draftPickKey(p) === key));
}

export function countedDraftPool(cards: DraftCard[]): (DraftCard & { count: number })[] {
  const groups = new Map<number, DraftCard & { count: number }>();
  for (const card of cards) {
    const existing = groups.get(card.arena_id);
    if (existing) existing.count++;
    else groups.set(card.arena_id, { ...card, count: 1 });
  }
  return [...groups.values()];
}

/** Match the deck comparison's printed front-face cost; unknown stays last. */
export function selectedCardManaValue(cost?: string): number | null {
  if (typeof cost !== 'string') return null;
  const front = cost.split(/\s*\/\/\s*/)[0];
  if (front === '') return 0;
  const symbols = [...front.matchAll(/\{([^}]+)\}/g)];
  if (symbols.map(match => match[0]).join('') !== front) return null;
  return symbols.reduce((sum, [, symbol]) => sum + (/^\d+$/.test(symbol) ? Number(symbol)
    : ['X', 'Y', 'Z'].includes(symbol) ? 0 : /^2\//.test(symbol) ? 2 : 1), 0);
}

export function selectedCardColumns(cards: DraftCard[], metadata: ReadonlyMap<number, { mana_cost?: string }>) {
  const columns = new Map<number | null, (DraftCard & { count: number })[]>();
  for (const card of countedDraftPool(cards)) {
    const cost = selectedCardManaValue(metadata.get(card.arena_id)?.mana_cost);
    const stack = columns.get(cost) ?? [];
    stack.push(card); columns.set(cost, stack);
  }
  return [...columns].sort(([a], [b]) => a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b)
    .map(([cost, cards]) => ({ cost, cards }));
}

/** Legacy captures mark completeness per hand; a later hand cannot repair an earlier gap. */
export function draftPoolIsPartial(picks: DraftPick[], index: number): boolean {
  return picks.slice(0, index + 1).some((pick, i) => {
    if (!pick.complete) return true;
    const previous = picks[i - 1];
    if (!previous) return pick.pack_number !== 1 || pick.pick_number !== 1;
    return !(pick.pack_number === previous.pack_number && pick.pick_number === previous.pick_number + 1 ||
      pick.pack_number === previous.pack_number + 1 && pick.pick_number === 1);
  });
}

const missingLabels: Record<string, string> = {
  candidates: '缺少候选包', selected: '缺少实际选择', pool_before: '选前牌池不完整',
  pool_after: '选后牌池不完整', pick_gap: '此前有漏手', missing_pick: '有漏手',
  capture_gap: '采集曾中断', selection: '缺少实际选择', pack: '缺少候选包',
  prior_pick: '此前有漏手', candidate_pack: '缺少候选包', selected_card: '缺少实际选择',
  conflicting_observations: '来源记录互相冲突', unsupported_multi_pick: '本手包含多张选择，暂不支持逐张标记',
  selection_not_in_pack: '实际选择未出现在候选包中', timestamp: '缺少选牌时间',
  history_unverified: '此前的选牌记录尚未核实',
};

export function draftPickWarning(pick: DraftPick, partialPool = false): string | null {
  const warnings = [];
  if (!pick.candidates.length) warnings.push('缺少候选包');
  if (!pick.selected) warnings.push('缺少实际选择');
  else if (pick.candidates.length && !pick.candidates.some(card => card.arena_id === pick.selected!.arena_id)) {
    warnings.push('实际选择未出现在候选包中');
  }
  if (!pick.complete || partialPool) warnings.push('本手或此前的记录不完整，牌池仅表示已观察到的卡牌');
  for (const field of pick.missing) if (missingLabels[field]) warnings.push(missingLabels[field]);
  return [...new Set(warnings)].join('；') || null;
}
