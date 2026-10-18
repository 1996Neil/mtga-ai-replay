import { CoachSyncError } from './coach-sync-error.mjs';
import { describeMatchMode } from './match-mode.mjs';

// Closed, evidence-backed vocabulary. New event identifiers require review;
// an opponent name or bot flag never establishes tutorial status.
const tutorials = new Set(Array.from({ length: 5 }, (_, i) => `NPE_Tutorial_PlayFamiliar${i + 1}`));
const ordinary = new Set(['Play', 'DualColorPrecons', 'QuickDraft_FRA_20261008', 'MWM_HistoricPauper_20261006', 'Jump In']);
function classify(value) {
  if (tutorials.has(value)) return 'tutorial';
  if (ordinary.has(value) || /^(?:传统)?(?:标准|炼金|史迹|Explorer|Pioneer|Timeless)?排位(?:（赛制未知）)?$/.test(value)) return 'ordinary';
  const mode = describeMatchMode({ event_id: value });
  return ['ranked', 'jump_in'].includes(mode.mode_key) ? 'ordinary' : 'unknown';
}
export function tutorialEligibility(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'hold_unknown';
  const values = ['event_id', 'queue_id', 'event'].map(key => metadata[key]);
  if (values.some(value => value != null && typeof value !== 'string')) return 'hold_unknown';
  const kinds = values.filter(value => typeof value === 'string' && value.trim()).map(value => classify(value.trim()));
  if (kinds.includes('tutorial') && kinds.includes('ordinary')) return 'hold_conflict';
  if (!kinds.length || kinds.includes('unknown')) return 'hold_unknown';
  return kinds.includes('tutorial') ? 'skip_tutorial' : 'not_excluded_by_tutorial_rule';
}
export function assertTutorialUploadEligible(metadata) {
  const decision = tutorialEligibility(metadata);
  if (decision !== 'not_excluded_by_tutorial_rule') {
    const error = new CoachSyncError(decision === 'skip_tutorial' ? 'SYNC_TUTORIAL_EXCLUDED' : 'SYNC_TUTORIAL_HOLD',
      decision === 'skip_tutorial' ? 'Tutorial replay excluded from new uploads; local history is preserved.' : 'Replay event classification is unknown or conflicting; upload is held.');
    error.eligibility = decision;
    throw error;
  }
  return decision;
}
