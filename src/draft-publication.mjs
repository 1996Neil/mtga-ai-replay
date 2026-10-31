import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { listReplays, listReplayDecks, getReplay } from './history.mjs';
import { listDraftRuns } from './draft-runs.mjs';
import { projectDraftCaptures } from './draft-capture.mjs';
import { bindDraftCaptures, recentDraftCourses, mergeDraftCourse, verifyDraftCourseMatches } from './draft-binding.mjs';
import { parseDraftBackup } from './draft-backup.mjs';
import { draftSourceFingerprint, draftLinkPath, linkText, linkDigest, parseDraftLinks, validateDraftLinkSources } from './draft-link-contract.mjs';
import { serializeCoachJson, buildCoachBundle } from './coach-bundle.mjs';
import { readSyncCache, syncDigest } from './sync-cache.mjs';
import { atomicSyncWrite, safeSyncOutputParents } from './coach-sync.mjs';
import { draftOwnershipPath, readDraftOwnershipCorrections, draftOwnershipCorrection } from './draft-ownership.mjs';

const SHA = /^[a-f0-9]{64}$/;
const basic = name => /^(?:Snow-Covered )?(?:Plains|Island|Swamp|Mountain|Forest|Wastes)$/.test(name ?? '');
const fail = () => { throw Error('Draft publication evidence is invalid.'); };
let rulesPromise;
function publicationRules() {
  rulesPromise ??= Promise.all(['draft-publication.mjs', 'draft-binding.mjs', 'draft-link-contract.mjs', 'draft-ownership.mjs', 'coach-bundle.mjs']
    .map(path => readFile(new URL(path, import.meta.url)))).then(parts => linkDigest(Buffer.concat(parts)));
  return rulesPromise;
}
async function proofCache(dataDir) {
  try {
    const path = join(dataDir, 'draft-sync/match-proofs.json'), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) return {};
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value.schema === 'MTGA_DRAFT_MATCH_PROOFS_V1' && value.entries && !Array.isArray(value.entries) &&
      Object.keys(value.entries).length <= 512 ? value.entries : {};
  } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return {}; throw error; }
}
export async function cachedDraftDecks(dataDir, history) {
  const records = await proofCache(dataDir), decks = new Map();
  for (const match of history) if (records[match.id]?.local_revision === match.replay_revision &&
    Array.isArray(records[match.id].local_deck)) decks.set(match.id, records[match.id].local_deck);
  return decks;
}
export function capturesInBackup(snapshot, work = {}) {
  const result = new Map();
  for (const account of snapshot.index.accounts) {
    const index = parseDraftBackup(account.path, snapshot.files.get(account.path));
    const observations = index.chunks.flatMap(chunk => parseDraftBackup(chunk.path, snapshot.files.get(chunk.path)).observations);
    result.set(account.account_key, projectDraftCaptures(observations, { gaps: index.gaps,
      onProject: value => {
        work.segments_built = (work.segments_built ?? 0) + value.built;
        work.segments_reused = (work.segments_reused ?? 0) + value.reused;
      } }));
  }
  return result;
}
export async function loadDraftCourses(dataDir, history) {
  const courses = new Map((await listDraftRuns({ dataDir })).map(course => [course.run_id, course]));
  for (const course of await recentDraftCourses(history, { dataDir, cache: {} }))
    courses.set(course.run_id, mergeDraftCourse(courses.get(course.run_id), course));
  return [...courses.values()];
}
/** Verify the published manifest and the exact coach bytes containing match/deck.
 * Decks remain in the main coach JSON even when game states use multipart refs. */
export async function readPublishedDraftMatch(git, revision, entry) {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision) ||
    !/^matches\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry.path ?? '') || !SHA.test(entry.content_hash ?? '')) fail();
  const read = async path => {
    const size = Number(String(await git(['cat-file', '-s', `${revision}:${path}`])).trim());
    if (!Number.isSafeInteger(size) || size < 1 || size > 2 * 1024 * 1024) fail();
    const bytes = await git(['show', `${revision}:${path}`], 'buffer');
    if (Buffer.byteLength(bytes) !== size) fail();
    return bytes.toString('utf8');
  };
  const manifest = JSON.parse(await read(`${entry.path}/manifest.json`));
  if (manifest.schema !== 'MTGA_COACH_MANIFEST_V1' || manifest.match_id !== entry.match_id ||
    manifest.content_hash !== entry.content_hash || linkDigest(serializeCoachJson(manifest.files)) !== entry.content_hash) fail();
  const coachText = await read(`${entry.path}/coach.json`), expected = manifest.files?.['coach.json'];
  if (!expected || expected.bytes !== Buffer.byteLength(coachText) || expected.sha256 !== linkDigest(coachText)) fail();
  const coach = JSON.parse(coachText);
  if (coach.schema !== 'MTGA_FULL_COACH_V1' || coach.match?.id !== entry.match_id || !Array.isArray(coach.deck)) fail();
  const eventId = coach.match.event_id ?? coach.match.event;
  const cardText = await read(`${entry.path}/cards.json`), expectedCards = manifest.files?.['cards.json'];
  if (!expectedCards || expectedCards.bytes !== Buffer.byteLength(cardText) || expectedCards.sha256 !== linkDigest(cardText)) fail();
  const cards = JSON.parse(cardText);
  if (!Array.isArray(cards)) fail();
  const sourceCommit = String(await git(['log', '-1', '--format=%H', revision, '--', `${entry.path}/manifest.json`])).trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sourceCommit)) fail();
  return { match: coach.match, deck: coach.deck, cards, multipart: Boolean(coach.reference_encoding), proof: {
    path: entry.path, content_hash: entry.content_hash, coach_sha256: expected.sha256, source_commit: sourceCommit,
    event_id: eventId, game_count: Array.isArray(coach.games) ? coach.games.length : null,
  } };
}

export async function buildPublishedDraftLinks(snapshot, { dataDir, git, revision, work = {} }) {
  const ownershipCorrections = await readDraftOwnershipCorrections(dataDir);
  let priorCorrections;
  const restoredCorrections = () => priorCorrections ??= (async () => {
    // An explicit correction survives restore/retry without a machine-local ledger.
    const corrections = [];
    if (!String(await git(['ls-tree', '--name-only', revision, '--', 'drafts/index.json'])).trim())
      return { corrections };
    const read = async path => {
      const size = Number(String(await git(['cat-file', '-s', `${revision}:${path}`])).trim());
      if (!Number.isSafeInteger(size) || size < 1 || size > 4 * 1024 * 1024) fail();
      const text = String(await git(['show', `${revision}:${path}`]));
      if (Buffer.byteLength(text) !== size) fail();
      return text;
    };
    const root = parseDraftBackup('drafts/index.json', await read('drafts/index.json'));
    for (const account of root.accounts) {
      if (!account.bindings) continue;
      const text = await read(account.bindings.path);
      if (linkDigest(text) !== account.bindings.sha256 || Buffer.byteLength(text) !== account.bindings.bytes) fail();
      const doc = parseDraftLinks(account.bindings.path, text);
      if (doc.runs.length !== account.bindings.runs) fail();
      for (const row of doc.runs) if (row.ownership) corrections.push({
        sources: row.sources, source_account_key: account.account_key, account_key: row.ownership.account_key,
      });
    }
    return { corrections };
  })();
  const captures = capturesInBackup(snapshot, work), history = await listReplays({ dataDir, limit: null });
  const rawCourses = await loadDraftCourses(dataDir, history);
  const relevantCourses = new Set([...captures.values()].flatMap(runs =>
    bindDraftCaptures(runs, rawCourses).filter(run => run.binding === 'matched_pool').map(run => run.bound_run_id)));
  const cached = await proofCache(dataDir), localHistory = new Map(history.map(match => [match.id, match]));
  const localDecks = new Map(), changedDecks = [];
  for (const id of new Set(rawCourses.filter(course => relevantCourses.has(course.run_id)).flatMap(course => course.matches.map(match => match.id)))) {
    const previous = cached[id];
    if (previous?.local_revision === localHistory.get(id)?.replay_revision && Array.isArray(previous.local_deck))
      localDecks.set(id, previous.local_deck);
    else changedDecks.push(id);
  }
  if (changedDecks.length) for (const [id, deck] of await listReplayDecks(changedDecks, { dataDir })) localDecks.set(id, deck);
  work.local_decks_read = changedDecks.length;
  const localOwners = new Map(history.map(match => [match.id, match.account_key]));
  const localCourses = verifyDraftCourseMatches(rawCourses, localDecks, localOwners);
  let remoteIndex = { matches: [] };
  const hasIndex = String(await git(['ls-tree', '--name-only', revision, '--', 'index.json'])).trim();
  if (hasIndex) {
    const size = Number(String(await git(['cat-file', '-s', `${revision}:index.json`])).trim());
    if (!Number.isSafeInteger(size) || size > 4 * 1024 * 1024) fail();
    remoteIndex = JSON.parse(String(await git(['show', `${revision}:index.json`])));
    if (remoteIndex.schema !== 'MTGA_COACH_INDEX_V1' || !Array.isArray(remoteIndex.matches) ||
      new Set(remoteIndex.matches.map(entry => entry.match_id)).size !== remoteIndex.matches.length) fail();
  }
  const entries = new Map(remoteIndex.matches.map(entry => [entry.match_id, entry]));
  const generation = await readSyncCache(dataDir, 'replay-coach-generation-cache.json');
  const remoteDecks = new Map(), remoteOwners = new Map(), proofs = new Map(), remoteMatches = new Map();
  const failures = new Set();
  const wantedIds = [...new Set(localCourses.filter(course => relevantCourses.has(course.run_id)).flatMap(course => course.matches.map(match => match.id)))];
  const paths = wantedIds.filter(id => entries.has(id)).flatMap(id =>
    ['manifest.json', 'coach.json', 'cards.json'].map(name => `${entries.get(id).path}/${name}`));
  const objects = new Map();
  if (paths.length) for (const row of String(await git(['ls-tree', '-rz', revision, '--', ...paths])).split('\0').filter(Boolean)) {
    const [meta, path] = row.split('\t'), [mode, type, oid] = meta.split(' ');
    if (type !== 'blob' || !['100644', '100755'].includes(mode) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid)) fail();
    objects.set(path, oid);
  }
  const checks = {}, rules = await publicationRules();
  const remember = (id, verdict) => {
    checks[id] = { ...verdict, local_revision: localHistory.get(id)?.replay_revision,
      local_deck: (localDecks.get(id) ?? []).map(card => ({ arena_id: card.arena_id, name: card.name, quantity: card.quantity ?? card.Quantity ?? 1 })) };
  };
  work.proofs_reused = 0; work.proofs_checked = 0; work.canonical_builds = 0;
  for (const id of wantedIds) {
    const entry = entries.get(id);
    if (!entry) { failures.add(id); continue; }
    const local = localHistory.get(id);
    const objectIds = ['manifest.json', 'coach.json', 'cards.json'].map(name => objects.get(`${entry.path}/${name}`));
    if (objectIds.some(oid => !oid)) fail();
    const generated = generation?.matches?.[id];
    const key = linkDigest(JSON.stringify([rules, local?.replay_revision, entry.path, entry.content_hash, objectIds,
      generated?.fast_snapshot, generated?.content_hash, generated?.history_key]));
    let source;
    const prior = cached[id];
    if (prior?.key === key && typeof prior.ok === 'boolean') {
      work.proofs_reused++;
      remember(id, prior);
      if (!prior.ok) { failures.add(id); continue; }
      source = prior.source;
      if (source?.match?.id !== id || source.proof?.path !== entry.path ||
        source.proof?.content_hash !== entry.content_hash || !Array.isArray(source.deck)) fail();
    } else {
      work.proofs_checked++;
    // A malformed or tampered remote object aborts publication; it is not a
    // successful "pending" relationship.
    source = await readPublishedDraftMatch(git, revision, entry);
    if (!local || !SHA.test(local.replay_revision ?? '') ||
      source.proof.event_id !== (local.event_id ?? local.event)) { failures.add(id); remember(id, { key, ok: false }); continue; }
    // Receipts are only hints: old receipt bootstrapping cannot prove local
    // facts equal published facts. Rebuild with the published card dictionary
    // and compare the complete canonical bundle hash before accepting a link.
    const replay = await getReplay(id, { dataDir });
    const historyKey = entry.path.slice('matches/'.length);
    const exactGeneratedSource = generated?.fast_snapshot === syncDigest(replay) &&
      generated.content_hash === entry.content_hash && generated.history_key === historyKey;
    if (!exactGeneratedSource) {
      work.canonical_builds++;
      const rebuilt = await buildCoachBundle(replay, { cards: source.cards, historyKey, multipart: source.multipart });
      if (rebuilt.contentHash !== entry.content_hash) { failures.add(id); remember(id, { key, ok: false }); continue; }
    }
    remember(id, { key, ok: true, source: { match: { id: source.match.id, account_key: source.match.account_key ?? null,
      started_at: source.match.started_at, result: source.match.result ?? null },
      deck: source.deck.map(card => ({ arena_id: card.arena_id, name: card.name, quantity: card.quantity ?? 1 })), proof: source.proof } });
    }
    remoteDecks.set(id, source.deck);
    remoteOwners.set(id, source.match.account_key ?? null);
    proofs.set(id, { ...source.proof, local_revision: local.replay_revision });
    remoteMatches.set(id, { id, started_at: source.match.started_at, result: source.match.result ?? null,
      game_count: source.proof.game_count });
  }
  const remoteCourses = verifyDraftCourseMatches(rawCourses.map(course => ({ ...course,
    matches: course.matches.filter(match => remoteMatches.has(match.id)).map(match => remoteMatches.get(match.id)),
  })), remoteDecks, remoteOwners);
  const documents = new Map();
  for (const [account, sourceRuns] of captures) {
    const originals = new Map(sourceRuns.map(run => [run.run_id, run]));
    const localRuns = new Map(bindDraftCaptures(sourceRuns, localCourses).flatMap(run =>
      (run.capture_run_ids ?? [run.run_id]).map(id => [id, run])));
    const runs = await Promise.all(bindDraftCaptures(sourceRuns, remoteCourses).map(async run => {
      const local = localRuns.get(run.run_id), matched = run.binding === 'matched_pool';
      const missing = (local?.matches ?? []).map(match => match.id).filter(id => !run.matches.some(match => match.id === id));
      const sourceIds = run.capture_run_ids ?? [run.run_id];
      const row = {
        run_id: run.run_id, sources: sourceIds.map(id => ({ run_id: id, sha256: draftSourceFingerprint(originals.get(id)) })),
        event_id: run.event_id, status: matched ? 'linked' : 'pending',
        reason: matched ? null : missing.length ? 'awaiting_match_upload' : run.binding_reason,
        course: matched ? { run_id: run.bound_run_id, card_ids: run.card_pool.map(card => card.arena_id),
          wins: run.course_wins ?? null, losses: run.course_losses ?? null, module: run.current_module ?? null } : null,
        matches: matched ? run.matches.map(match => {
          const deck = remoteDecks.get(match.id), grouped = new Map();
          for (const card of deck) if (!basic(card.name)) grouped.set(card.arena_id, (grouped.get(card.arena_id) ?? 0) + (card.quantity ?? 1));
          const { event_id, game_count, ...proof } = proofs.get(match.id);
          return { id: match.id, account_key: match.account_key ?? null, started_at: new Date(match.started_at).toISOString(),
            result: match.result, game_count: match.game_count, ...proof,
            nonbasic_deck: [...grouped].sort((a, b) => a[0] - b[0]).map(([arena_id, quantity]) => ({ arena_id, quantity })),
            total_cards: deck.reduce((sum, card) => sum + (card.quantity ?? 1), 0) };
        }) : [], pending_match_ids: missing.sort(),
      };
      const ownership = draftOwnershipCorrection(row, account, ownershipCorrections) ??
        (matched && run.binding_account_status === 'conflict'
          ? draftOwnershipCorrection(row, account, await restoredCorrections()) : null);
      return ownership ? { ...row, ownership } : row;
    }));
    const doc = { schema: 'MTGA_DRAFT_BINDINGS_V1', account_key: account, runs };
    parseDraftLinks(draftLinkPath(account), linkText(doc)); validateDraftLinkSources(doc, sourceRuns);
    documents.set(account, doc);
  }
  await safeSyncOutputParents(dataDir, 'draft-sync/match-proofs.json');
  await atomicSyncWrite(join(dataDir, 'draft-sync/match-proofs.json'), JSON.stringify({
    schema: 'MTGA_DRAFT_MATCH_PROOFS_V1', entries: Object.fromEntries(Object.entries(checks).slice(0, 512)),
  }));
  return documents;
}

/** Stable input signal; collection polling never forces a draft upload. */
export async function draftBindingInputKey(dataDir) {
  const values = [];
  for (const relative of ['draft-capture.sqlite3', 'replays.sqlite3', 'replays.sqlite3-wal', 'replay-ingest.sqlite3', 'replay-ingest.sqlite3-wal',
    'draft-runs.sqlite3', 'draft-runs.sqlite3-wal', 'coach-sync/state.json', 'replay-coach-generation-cache.json', draftOwnershipPath]) {
    try { const stat = await lstat(join(dataDir, relative), { bigint: true }); values.push([relative, String(stat.size), String(stat.mtimeNs)]); }
    catch (error) { if (error.code !== 'ENOENT') throw error; values.push([relative, null]); }
  }
  return linkDigest(JSON.stringify([values, await publicationRules()]));
}

/** Viewer consumes the same hash-bound documents that passed remote readback.
 * No course database is needed to restore published relationships. */
export async function readPublishedDraftLinks(captures, { dataDir, history }) {
  let bytes;
  try { bytes = await readFile(join(dataDir, 'draft-sync/published-bindings.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const saved = JSON.parse(bytes), receipt = JSON.parse(await readFile(join(dataDir, 'draft-sync/published.json'), 'utf8'));
  if (saved.schema !== 'MTGA_PUBLISHED_DRAFT_BINDINGS_V1' || receipt.verified !== true ||
    receipt.revision !== saved.revision || receipt.content_hash !== saved.content_hash ||
    linkDigest(linkText(saved.index)) !== saved.content_hash) fail();
  parseDraftBackup('drafts/index.json', linkText(saved.index));
  if (saved.index.schema !== 'MTGA_DRAFT_ACCOUNTS_V2' || !saved.documents || Array.isArray(saved.documents)) fail();
  const baselines = new Map(history.map(match => [match.id, match]));
  const output = [];
  for (const account of saved.index.accounts) {
    const sourceRuns = captures.filter(run => run.account_key === account.account_key);
    const sourceMap = new Map(sourceRuns.map(run => [run.run_id, run]));
    const doc = saved.documents[account.account_key], text = linkText(doc);
    if (linkDigest(text) !== account.bindings.sha256 || Buffer.byteLength(text) !== account.bindings.bytes ||
      doc.runs.length !== account.bindings.runs) fail();
    parseDraftLinks(account.bindings.path, text); validateDraftLinkSources(doc, sourceRuns);
    for (const row of doc.runs) {
      const run = sourceMap.get(row.run_id);
      if (row.status !== 'linked') {
        output.push({ ...run, capture_run_ids: row.sources.map(source => source.run_id),
          binding: 'unresolved', binding_reason: row.reason, binding_publication: saved.revision,
          binding_pending_matches: row.pending_match_ids.length });
        continue;
      }
      const matches = row.matches.filter(match => {
        const current = baselines.get(match.id);
        return current && current.replay_revision === match.local_revision;
      }).map(match => ({ id: match.id, account_key: match.account_key, started_at: match.started_at,
        result: match.result, game_count: match.game_count, binding_evidence: 'published_pool_and_main_deck' }));
      if (!matches.length) {
        output.push({ ...run, capture_run_ids: row.sources.map(source => source.run_id),
          binding: 'unresolved', binding_reason: 'missing_matches', binding_publication: saved.revision,
          binding_pending_matches: row.pending_match_ids.length + row.matches.length });
        continue;
      }
      const accounts = new Set(matches.map(match => match.account_key));
      const matchAccount = accounts.size === 1 ? [...accounts][0] : null;
      const wins = matches.filter(match => match.result === 'Win').length, losses = matches.filter(match => match.result === 'Loss').length;
      const scoreVerified = !row.pending_match_ids.length && matches.length === row.matches.length && matches.every(match => ['Win', 'Loss', 'Draw'].includes(match.result)) &&
        row.course.wins === wins && row.course.losses === losses;
      const names = new Map(run.picks.flatMap(pick => pick.candidates).map(card => [card.arena_id, card.name]));
      const owner = row.ownership?.account_key ?? run.account_key;
      output.push({ ...run, account_key: owner,
        ...(row.ownership ? { capture_account_key: run.account_key, ownership_corrected: true } : {}),
        binding: 'matched_pool', binding_method: 'exact_card_pool', binding_reason: null,
        binding_publication: saved.revision, bound_run_id: row.course.run_id, binding_card_count: row.course.card_ids.length,
        binding_pending_matches: row.pending_match_ids.length + row.matches.length - matches.length,
        binding_account_key: matchAccount, binding_account_status: matchAccount ? matchAccount === owner ? 'matched' : 'conflict' : 'unknown',
        capture_run_ids: row.sources.map(source => source.run_id), current_module: row.course.module,
        card_pool: row.course.card_ids.map(arena_id => ({ arena_id, name: names.get(arena_id) ?? `Arena card ${arena_id}` })),
        course_wins: row.course.wins, course_losses: row.course.losses, replay_wins: wins, replay_losses: losses,
        score_verified: scoreVerified, matches,
        status: scoreVerified && /complete|finish|claim|reward|end/i.test(row.course.module ?? '') ? 'completed' : 'incomplete' });
    }
  }
  if (new Set(output.flatMap(run => run.capture_run_ids ?? [run.run_id])).size !== captures.length) fail();
  return output;
}
