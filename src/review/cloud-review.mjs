import { createHash } from 'node:crypto';
import { resolveCoachBundle, serializeCoachJson } from '../coach-bundle.mjs';
import { validateBundleFiles, validateExpandedCoach } from '../sync-security.mjs';
import { findReviewGame, normalizeReplayReview, visibleCardNames, reviewFingerprintAsync } from './review-model.mjs';
import { CLOUD_REVIEW_POLICY, parseCloudReview, reviewPath, reviewReject } from './cloud-review-contract.mjs';

export { CLOUD_REVIEW_POLICY, reviewPath } from './cloud-review-contract.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{64}$/;
const sourceVerdicts = new WeakSet();
const deepFreeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
};
function jsonFile(files, path, max = 2 * 1024 * 1024) {
  const bytes = files.get(path);
  if (!(typeof bytes === 'string' || bytes instanceof Uint8Array) || Buffer.byteLength(bytes) > max) reviewReject('source-file');
  validateBundleFiles(new Map([[path, bytes]]));
  try { return JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { reviewReject('source-json'); }
}

/** Verify exact published bytes; no disk paths, network, nearest frame or mutable
 * caller verdicts. All referenced parts must exist and belong to this match. */
export function readPublishedReviewSource({ files, matchId, revision }) {
  reviewPath(matchId, 1);
  if (!(files instanceof Map) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision ?? '')) reviewReject('source-revision');
  const index = jsonFile(files, 'index.json');
  if (index.schema !== 'MTGA_COACH_INDEX_V1' || !Array.isArray(index.matches)) reviewReject('source-index');
  const matches = index.matches.filter(item => item.match_id === matchId);
  if (matches.length !== 1) reviewReject('source-match');
  const entry = matches[0];
  if (!/^matches\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry.path ?? '') || !SHA.test(entry.content_hash ?? '')) reviewReject('source-index');
  const manifest = jsonFile(files, `${entry.path}/manifest.json`);
  if (manifest.schema !== 'MTGA_COACH_MANIFEST_V1' || manifest.match_id !== matchId || manifest.content_hash !== entry.content_hash ||
      !manifest.files || Array.isArray(manifest.files) || digest(serializeCoachJson(manifest.files)) !== entry.content_hash) reviewReject('source-content-hash');
  const names = Object.keys(manifest.files);
  if (names.length > 515 || !['summary.json', 'coach.json', 'cards.json'].every(name => names.includes(name))) reviewReject('source-manifest');
  const objects = new Map(), parts = new Map(); let total = 0;
  for (const name of names) {
    const root = ['summary.json', 'coach.json', 'cards.json'].includes(name);
    if (!root && (!name.startsWith(`${entry.path}/parts/`) || !/^matches\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/parts\/part-[0-9]{4,6}\.json$/.test(name))) reviewReject('source-part-path');
    const path = root ? `${entry.path}/${name}` : name, bytes = files.get(path), expected = manifest.files[name];
    if (!(typeof bytes === 'string' || bytes instanceof Uint8Array) || !expected || !SHA.test(expected.sha256 ?? '') ||
        !Number.isSafeInteger(expected.bytes) || expected.bytes < 1 || expected.bytes > 2 * 1024 * 1024 ||
        Buffer.byteLength(bytes) !== expected.bytes || digest(bytes) !== expected.sha256 || (total += expected.bytes) > 128 * 1024 * 1024) reviewReject('source-file-hash');
    const value = jsonFile(files, path);
    if (root) objects.set(name, value); else parts.set(name, value);
  }
  let replay;
  try { replay = resolveCoachBundle(objects.get('coach.json'), parts,
    { strict: true, maxNodes: 8000000, maxDepth: 80, maxStringBytes: 64 * 1024 * 1024 }); }
  catch { reviewReject('unresolved-source'); }
  if (replay.schema !== 'MTGA_FULL_COACH_V1' || replay.match?.id !== matchId || objects.get('summary.json')?.match_id !== matchId || !Array.isArray(replay.games)) reviewReject('source-identity');
  // Reassembled chunks must undergo the same privacy checks as continuous data.
  validateExpandedCoach(replay);
  const numbers = new Set();
  for (const [i, game] of replay.games.entries()) {
    const number = game.game_number ?? i + 1;
    if (!Number.isSafeInteger(number) || number < 1 || numbers.has(number) || !Array.isArray(game.steps)) reviewReject('source-game');
    numbers.add(number);
    const anchors = new Set();
    for (const step of game.steps) {
      if (!/^T[0-9]+-A[0-9]+$/.test(step.anchor ?? '') || anchors.has(step.anchor)) reviewReject('source-anchor');
      anchors.add(step.anchor);
    }
    for (const snapshot of [...Object.values(game.states ?? {}), ...game.steps.flatMap(step => [step.state, step.state_before]).filter(Boolean)]) {
      if (!snapshot || typeof snapshot !== 'object') reviewReject('source-state');
      if (snapshot.$ref || snapshot.$chunks) reviewReject('unresolved-source');
      const hand = snapshot.players?.opponent?.hand;
      if (hand !== undefined && (!Array.isArray(hand) || hand.length)) reviewReject('hidden-opponent-hand');
    }
  }
  const source = deepFreeze({ match_id: matchId, content_hash: entry.content_hash, revision,
    history_key: entry.path.slice(8), cards: objects.get('cards.json'), replay });
  sourceVerdicts.add(source); return source;
}

export function validateCloudReviewBinding(raw, source, { policyVersion = CLOUD_REVIEW_POLICY } = {}) {
  if (!sourceVerdicts.has(source)) reviewReject('unverified-source');
  const path = reviewPath(source.match_id, raw?.game_number);
  const report = parseCloudReview(JSON.stringify(raw), { path });
  validateBundleFiles(new Map([[path, JSON.stringify(report)]]));
  const game = findReviewGame(source.replay, report.game_number);
  if (!game || report.match_id !== source.match_id) reviewReject('game-identity');
  if (report.source_content_hash !== source.content_hash || report.policy_version !== policyVersion) return { status: 'stale', report };
  if (report.coverage.actions_total !== game.steps.length || report.coverage.states_resolved !== Object.keys(game.states ?? {}).length) reviewReject('coverage-count');
  const steps = new Map(game.steps.map(step => [step.anchor, step]));
  const stateAt = point => {
    const step = steps.get(point.anchor);
    if (!step) reviewReject('anchor');
    const value = point.boundary === 'before' ? step.state_before ?? game.states?.[step.before_state_id] : step.state ?? game.states?.[step.state_id];
    if (!value || value.$ref || value.$chunks || !value.players?.me || !value.players?.opponent) reviewReject('unresolved-boundary');
    return value;
  };
  const inspected = new Set();
  for (const point of report.coverage.inspected) {
    stateAt(point); const key = `${point.anchor}:${point.boundary}`;
    if (inspected.has(key)) reviewReject('duplicate-coverage'); inspected.add(key);
  }
  if (report.coverage.scope === 'all_actions' && new Set(report.coverage.inspected.map(point => point.anchor)).size !== game.steps.length) reviewReject('unproved-full-coverage');
  const noted = new Set();
  for (const note of report.notes) {
    if (!inspected.has(`${note.anchor}:${note.boundary}`)) reviewReject('note-not-inspected');
    if (noted.has(note.anchor)) reviewReject('duplicate-note'); noted.add(note.anchor);
    const visible = visibleCardNames(stateAt(note));
    if (note.cards.some(name => !visible.has(name))) reviewReject('unknown-visible-card');
  }
  return { status: 'ready', report };
}

/** Compatibility presentation only. Importance and uncertainty remain separate;
 * V1 severity is never promoted to a claim of a proven rules error. */
export async function adaptCloudReview(report, source) {
  const result = validateCloudReviewBinding(report, source);
  if (result.status !== 'ready') return { status: result.status };
  const game = findReviewGame(source.replay, report.game_number);
  const fingerprint = await reviewFingerprintAsync(game, source.replay.warnings);
  const review = normalizeReplayReview(source.replay, report.game_number, report, {
    source: `cloud:${report.generator.name}`, now: report.generated_at, fingerprint, cloudSemantics: true });
  review.summary.limitations = [...new Set([...report.coverage.limitations, ...review.summary.limitations])].slice(0, 4);
  return { status: 'ready', review: { ...review, cloud_schema: report.schema,
    source_content_hash: report.source_content_hash, cloud_policy_version: report.policy_version, coverage: report.coverage } };
}
