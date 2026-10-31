import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { validAccountKey } from '../account-scope.mjs';

export const MAX_DRAFT_REVIEW_BYTES = 256 * 1024;
const runIdentity = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && [...value].length <= max;
const key = pick => `${pick.pack_number}-${pick.pick_number}`;
const reject = () => { throw Error('Invalid draft review'); };
const ids = (cards, max) => {
  if (!Array.isArray(cards) || cards.length > max || cards.some(card => !integer(card?.arena_id, 1, 2147483647))) reject();
  return cards.map(card => card.arena_id);
};

/** Evidence identity, independent of display names, object identity and polling. */
export function draftReviewFingerprint(run) {
  if (!text(run?.event_id, 120) || !Array.isArray(run.picks) || !integer(run.picks.length, 1, 90)) reject();
  const seen = new Set();
  const picks = [...run.picks].sort((a, b) => a.pack_number - b.pack_number || a.pick_number - b.pick_number)
    .map(pick => {
      if (!integer(pick.pack_number, 1, 3) || !integer(pick.pick_number, 1, 30) || seen.has(key(pick))) reject();
      seen.add(key(pick));
      if (pick.selected != null && !integer(pick.selected.arena_id, 1, 2147483647)) reject();
      return { pack: pick.pack_number, pick: pick.pick_number,
        candidates: ids(pick.candidates, 100), selected: pick.selected?.arena_id ?? null,
        before: ids(pick.pool_before, 90), after: ids(pick.pool_after, 90), complete: pick.complete === true };
    });
  return createHash('sha256').update(JSON.stringify({ event: run.event_id, picks })).digest('hex');
}

export function validateDraftReview(report) {
  if (!exact(report, ['schema', 'run_id', 'account_key', 'event_id', 'source_fingerprint', 'generated_at', 'summary', 'notes']) ||
      report.schema !== 'MTGA_DRAFT_AI_REVIEW_V1' || !runIdentity(report.run_id) ||
      !validAccountKey(report.account_key) || !text(report.event_id, 120) ||
      !/^[a-f0-9]{64}$/.test(report.source_fingerprint) || !text(report.generated_at, 24) ||
      !Number.isFinite(Date.parse(report.generated_at)) ||
      new Date(report.generated_at).toISOString() !== report.generated_at ||
      !exact(report.summary, ['headline', 'overview', 'limitations']) ||
      !text(report.summary.headline, 240) || !text(report.summary.overview, 2000) ||
      !Array.isArray(report.summary.limitations) || report.summary.limitations.length > 4 ||
      report.summary.limitations.some(value => !text(value, 400)) ||
      !Array.isArray(report.notes) || report.notes.length > 90) reject();
  const seen = new Set();
  for (const note of report.notes) {
    if (!exact(note, ['pack_number', 'pick_number', 'importance', 'assessment', 'confidence', 'title',
      'observation', 'suggestion', 'rationale', 'limitation', 'selected', 'alternative']) ||
        !integer(note.pack_number, 1, 3) || !integer(note.pick_number, 1, 30) || seen.has(key(note)) ||
        !['critical', 'major', 'normal'].includes(note.importance) ||
        !['suggestion', 'possible_error', 'positive'].includes(note.assessment) ||
        !['high', 'medium', 'low'].includes(note.confidence) || !text(note.title, 240) ||
        !text(note.observation, 1400) || !text(note.suggestion, 1400) ||
        !text(note.rationale, 1400) || !text(note.limitation, 500)) reject();
    seen.add(key(note));
    for (const card of [note.selected, note.alternative]) {
      if (!exact(card, ['arena_id', 'name']) || !integer(card.arena_id, 1, 2147483647) || !text(card.name, 180)) reject();
    }
  }
  if (Buffer.byteLength(JSON.stringify(report)) > MAX_DRAFT_REVIEW_BYTES) reject();
  return report;
}

export function bindDraftReview(report, run, accountKey) {
  validateDraftReview(report);
  if (!validAccountKey(accountKey) || run.account_key !== accountKey ||
      report.account_key !== accountKey || report.run_id !== run.run_id || report.event_id !== run.event_id) reject();
  if (report.source_fingerprint !== draftReviewFingerprint(run)) return { status: 'stale', review: null };
  const picks = new Map(run.picks.map(pick => [key(pick), pick]));
  for (const note of report.notes) {
    const pick = picks.get(key(note));
    if (!pick?.complete || pick.selected?.arena_id !== note.selected.arena_id ||
        !pick.candidates.some(card => card.arena_id === note.selected.arena_id) ||
        !pick.candidates.some(card => card.arena_id === note.alternative.arena_id)) reject();
  }
  return { status: 'ready', review: report };
}

/** Fixed per-account paths only; no browser-supplied filename or model work. */
export async function readDraftReview(run, { dataDir, accountKey }) {
  if (!runIdentity(run?.run_id) || !validAccountKey(accountKey) || run.account_key !== accountKey) reject();
  let handle;
  try {
    const directory = join(dataDir, 'draft-reviews'), accountDirectory = join(directory, accountKey);
    for (const path of [directory, accountDirectory]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) reject();
    }
    const path = join(accountDirectory, `${run.run_id}.json`);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_DRAFT_REVIEW_BYTES) reject();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_DRAFT_REVIEW_BYTES) reject();
    const buffer = Buffer.alloc(MAX_DRAFT_REVIEW_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_DRAFT_REVIEW_BYTES) reject();
    const report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
    return bindDraftReview(report, run, accountKey);
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', review: null };
    return { status: 'error', review: null, error: '轮抽复盘读取或核对失败，未显示旧评论。' };
  } finally { await handle?.close(); }
}
