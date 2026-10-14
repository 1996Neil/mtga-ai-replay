export type ReviewBoundary = 'before' | 'after';
export type ReviewPoint = { anchor: string; boundary: ReviewBoundary };
export type CloudReviewV1 = {
  schema: 'MTGA_AI_REVIEW_V1'; match_id: string; game_number: number;
  source_content_hash: string; policy_version: string; generated_at: string;
  generator: { name: 'chatgpt-cloud-agent'; version: string };
  provenance: { source_revision: string; evidence: 'published-player-perspective';
    context_sources: string[]; summary_may_use_future: true };
  coverage: { scope: 'sampled' | 'all_actions'; actions_total: number; states_resolved: number;
    inspected: ReviewPoint[]; limitations: string[] };
  summary: { headline: string; overview: string; strengths: string[]; improvements: string[]; limitations: string[] };
  notes: Array<ReviewPoint & { severity: 'critical' | 'major' | 'tip' | 'positive';
    confidence: 'high' | 'medium' | 'low'; title: string; observation: string;
    suggestion: string; rationale: string; limitation: string; cards: string[] }>;
};
export type CloudReviewState = { status: 'missing' | 'ready' | 'stale' | 'syncing' | 'error';
  report: CloudReviewV1 | CloudReviewV2 | null; current_source_content_hash?: string;
  checked_at?: string; offline?: boolean; error?: string };
export type CloudReviewV2 = Omit<CloudReviewV1, 'schema' | 'notes'> & {
  schema: 'MTGA_AI_REVIEW_V2';
  notes: Array<Omit<CloudReviewV1['notes'][number], 'severity'> & {
    importance: 'critical' | 'major' | 'normal';
    assessment: 'suggestion' | 'possible_error' | 'positive';
  }>;
};
