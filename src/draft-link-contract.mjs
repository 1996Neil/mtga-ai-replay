import { createHash } from 'node:crypto';
import { completeDraftPool } from './draft-binding.mjs';
export const linkText = value => JSON.stringify(value, null, 2) + '\n';
export const linkDigest = value => createHash('sha256').update(value).digest('hex');
export const draftLinkPath = key => `drafts/accounts/${key}/bindings.json`;
const SHA = /^[a-f0-9]{64}$/, RUN = /^[a-f0-9]{32}$/, COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const positive = n => Number.isSafeInteger(n) && n > 0;
const count = n => Number.isSafeInteger(n) && n >= 0;
const fail = () => { throw Error('Invalid published draft association.'); };
const list = (value, max, valid) => Array.isArray(value) && value.length <= max && value.every(valid);
const unique = values => new Set(values).size === values.length;
export function draftSourceFingerprint(run) {
  return linkDigest(JSON.stringify({ event_id: run.event_id, picks: run.picks.map(p => ({
    pack: p.pack_number, pick: p.pick_number, candidates: p.candidates.map(c => c.arena_id),
    selected: p.selected?.arena_id ?? null, before: p.pool_before.map(c => c.arena_id),
    after: p.pool_after.map(c => c.arena_id), complete: p.complete, missing: p.missing,
  })) }));
}
export function parseDraftLinks(path, text) {
  const account = /^drafts\/accounts\/([a-f0-9]{64})\/bindings\.json$/.exec(path)?.[1];
  if (!account || typeof text !== 'string' || Buffer.byteLength(text) > 4 * 1024 * 1024) fail();
  const doc = JSON.parse(text);
  if (linkText(doc) !== text || !exact(doc, ['schema', 'account_key', 'runs']) ||
    doc.schema !== 'MTGA_DRAFT_BINDINGS_V1' || doc.account_key !== account || !Array.isArray(doc.runs) || doc.runs.length > 10000) fail();
  const allSources = new Set();
  for (const row of doc.runs) {
    if (!exact(row, ['run_id', 'sources', 'event_id', 'status', 'reason', 'course', 'matches', 'pending_match_ids',
      ...(Object.hasOwn(row, 'ownership') ? ['ownership'] : [])]) ||
      !RUN.test(row.run_id) || !list(row.sources, 1000, s => exact(s, ['run_id', 'sha256']) && RUN.test(s.run_id) && SHA.test(s.sha256)) ||
      !row.sources.length || row.sources[0].run_id !== row.run_id ||
      !/^[A-Za-z][A-Za-z0-9_-]{1,120}$/.test(row.event_id) || !['linked', 'pending'].includes(row.status) ||
      !list(row.pending_match_ids, 1000, id => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) || !unique(row.pending_match_ids) ||
      !Array.isArray(row.matches) || row.matches.length > 1000) fail();
    for (const source of row.sources) { if (allSources.has(source.run_id)) fail(); allSources.add(source.run_id); }
    if (row.status === 'pending') {
      if (!['incomplete_picks', 'missing_course', 'ambiguous_courses', 'missing_matches', 'awaiting_match_upload', 'evidence_unavailable'].includes(row.reason) ||
        row.course !== null || row.matches.length || Object.hasOwn(row, 'ownership')) fail();
      continue;
    }
    if (row.reason !== null || !row.matches.length || !exact(row.course, ['run_id', 'card_ids', 'wins', 'losses', 'module']) ||
      !RUN.test(row.course.run_id) || !list(row.course.card_ids, 90, positive) || row.course.card_ids.length < 3 ||
      !(row.course.wins === null || count(row.course.wins)) || !(row.course.losses === null || count(row.course.losses)) ||
      !(row.course.module === null || typeof row.course.module === 'string' && /^[A-Za-z0-9_-]{0,100}$/.test(row.course.module))) fail();
    const pool = new Map();
    for (const id of row.course.card_ids) pool.set(id, (pool.get(id) ?? 0) + 1);
    const matchIds = new Set();
    for (const match of row.matches) {
      if (!exact(match, ['id', 'account_key', 'started_at', 'result', 'game_count', 'path', 'content_hash',
        'coach_sha256', 'source_commit', 'local_revision', 'nonbasic_deck', 'total_cards',
        ...(Object.hasOwn(match, 'relation_hash') ? ['relation_hash'] : [])]) ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(match.id) || matchIds.has(match.id) ||
        !(match.account_key === null || SHA.test(match.account_key)) ||
        typeof match.started_at !== 'string' || !Number.isFinite(Date.parse(match.started_at)) || new Date(match.started_at).toISOString() !== match.started_at ||
        ![null, 'Win', 'Loss', 'Draw'].includes(match.result) || !(match.game_count === null || positive(match.game_count)) ||
        !/^matches\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(match.path) || !SHA.test(match.content_hash) ||
        !SHA.test(match.coach_sha256) || !COMMIT.test(match.source_commit) || !SHA.test(match.local_revision) ||
        (Object.hasOwn(match, 'relation_hash') && !SHA.test(match.relation_hash)) ||
        !positive(match.total_cards) || match.total_cards < 30 || match.total_cards > 250 ||
        !list(match.nonbasic_deck, 250, c => exact(c, ['arena_id', 'quantity']) && positive(c.arena_id) && positive(c.quantity)) ||
        match.nonbasic_deck.length < 8 || !unique(match.nonbasic_deck.map(c => c.arena_id))) fail();
      let copies = 0;
      for (const card of match.nonbasic_deck) {
        copies += card.quantity;
        if (card.quantity > (pool.get(card.arena_id) ?? 0)) fail();
      }
      if (copies < 12 || copies > match.total_cards || row.pending_match_ids.includes(match.id)) fail();
      matchIds.add(match.id);
    }
    if (Object.hasOwn(row, 'ownership') && (!exact(row.ownership, ['account_key', 'method']) ||
      !SHA.test(row.ownership.account_key) || row.ownership.account_key === account ||
      row.ownership.method !== 'verified_pool_and_match_identity' ||
      row.matches.some(match => match.account_key !== row.ownership.account_key))) fail();
  }
  return doc;
}
/** The publication's source fingerprints must cover every captured run exactly once. */
export function validateDraftLinkSources(doc, captures) {
  const sources = new Map(captures.map(run => [run.run_id, run]));
  const used = new Set();
  for (const row of doc.runs) for (const ref of row.sources) {
    const run = sources.get(ref.run_id);
    if (!run || run.account_key !== doc.account_key || run.event_id !== row.event_id ||
      draftSourceFingerprint(run) !== ref.sha256 || used.has(ref.run_id)) fail();
    if (row.sources.some(source => source.sha256 !== row.sources[0].sha256)) fail();
    if (row.status === 'linked') {
      const pool = completeDraftPool(run);
      if (!pool || JSON.stringify(pool.slice().sort((a, b) => a - b)) !==
        JSON.stringify(row.course.card_ids.slice().sort((a, b) => a - b))) fail();
    }
    used.add(ref.run_id);
  }
  if (used.size !== captures.length) fail();
}
