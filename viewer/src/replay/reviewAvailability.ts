export type ReviewStatus = 'loading' | 'missing' | 'stale' | 'syncing' | 'ready' | 'error';
type ReviewIdentity = { match_id: string; game_number: number };
export type ReviewScope = { matchId: string; gameNumber: number; steps: readonly unknown[] };
export type ReviewSnapshot<T extends ReviewIdentity> = ReviewScope & { status: ReviewStatus; review: T | null };

/** Never expose a previous game or a previous replay revision while its replacement loads. */
export function currentReviewSnapshot<T extends ReviewIdentity>(snapshot: ReviewSnapshot<T>, match: ReviewScope): {
  status: ReviewStatus; review: T | null;
} {
  if (snapshot.matchId !== match.matchId || snapshot.gameNumber !== match.gameNumber || snapshot.steps !== match.steps) {
    return { status: 'loading', review: null };
  }
  if (snapshot.status !== 'ready') return { status: snapshot.status, review: null };
  if (snapshot.review?.match_id !== match.matchId || snapshot.review.game_number !== match.gameNumber) {
    return { status: 'error', review: null };
  }
  return { status: 'ready', review: snapshot.review };
}

export function reviewLaunchPresentation(status: ReviewStatus, noteCount: number) {
  const labels: Record<ReviewStatus, string> = {
    loading: '正在读取复盘记录', syncing: '正在检查云端复盘', ready: `已有复盘记录，${noteCount} 条建议`,
    missing: '暂无复盘记录', stale: '复盘记录已过期，需要重新同步', error: '复盘记录读取失败，状态未知',
  };
  return {
    tone: status === 'ready' ? 'ready' : status === 'missing' || status === 'stale' ? 'missing' : 'unknown',
    // Distinct symbols and an accessible text status keep the meaning available without color.
    symbol: status === 'ready' ? '✓' : status === 'missing' || status === 'stale' ? '−' : status === 'error' ? '?' : '…',
    label: `AI 复盘${status === 'ready' ? ` · ${noteCount}` : ''}`,
    description: labels[status],
    busy: status === 'loading' || status === 'syncing',
  };
}
