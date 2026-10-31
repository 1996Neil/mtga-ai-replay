import { useEffect, useRef, useState } from 'react';
import type { DraftRun } from '../types/game';
import { currentDraftReview, draftReviewInputKey, parseDraftReviewResponse } from '../lib/draftReview';
import type { DraftReviewState } from '../lib/draftReview';

export function useDraftReview(run: DraftRun, account: string) {
  const identity = draftReviewInputKey(run);
  const [snapshot, setSnapshot] = useState<DraftReviewState>({
    identity, account, status: 'loading', review: null, error: '',
  });
  const [version, setVersion] = useState(0), epoch = useRef(0);
  useEffect(() => {
    const controller = new AbortController(), ticket = ++epoch.current;
    const scope = { identity, account };
    setSnapshot({ ...scope, status: 'loading', review: null, error: '' });
    if (!/^[a-f0-9]{64}$/.test(account)) {
      setSnapshot({ ...scope, status: 'missing', review: null, error: '请选择已识别的游戏账号后查看复盘。' });
      return () => { controller.abort(); epoch.current++; };
    }
    void (async () => {
      try {
        const response = await fetch(`/api/draft-runs/${encodeURIComponent(run.run_id)}/review?account=${encodeURIComponent(account)}`,
          { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw Error(`轮抽复盘暂时无法读取（${response.status}），可重新检查。`);
        const value = await response.json();
        if (!controller.signal.aborted && ticket === epoch.current)
          setSnapshot({ ...scope, ...parseDraftReviewResponse(value, run, account) });
      } catch (error) {
        if (!controller.signal.aborted && ticket === epoch.current)
          setSnapshot({ ...scope, status: 'error', review: null,
            error: error instanceof Error ? error.message : '轮抽复盘读取失败。' });
      }
    })();
    return () => { controller.abort(); epoch.current++; };
    // The identity includes every relevant pick value, not polling object references.
  }, [identity, account, version]);
  return { ...currentDraftReview(snapshot, identity, account), refresh: () => setVersion(value => value + 1) };
}
