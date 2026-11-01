import { filterAccount, validAccountKey } from './account-scope.mjs';
import { listCapturedDraftRuns, listUnknownDraftRuns, readDraftCapture } from './draft-capture.mjs';
import { listDraftRuns, withDraftRunLandColors } from './draft-runs.mjs';
import { bindDraftCaptures, recentDraftCourses, mergeDraftCourse, verifyDraftCourseMatches } from './draft-binding.mjs';
import { readPublishedDraftLinks, cachedDraftDecks } from './draft-publication.mjs';
import { discoverCardDatabase, loadCardLandColors, loadCardNames } from './cards.mjs';
import { createTaskJournal } from './task-journal.mjs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileRevision, revisionMemo } from './lightweight.mjs';
import { readFile, stat, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataDir, listReplays, listReplayDecks, getReplay, getArchivedCard } from './history.mjs';
import { createCardIdentityResolver } from './card-image-identity.mjs';
import { getCardMetadata, getCardImage, cardImageIsCached, cardImageRetryAfter, cardImageFailure } from './card-cache.mjs';
import { createCoachContext } from './coach-context.mjs';
import { loadInstalledChineseDisplayNames } from './display-names.mjs';
import { createViewerSync } from './viewer-sync.mjs';
import { createAccountViewerCollections } from './viewer-collection.mjs';
import { notifyViewerTask } from './task-notification.mjs';
import { createLocalReplayHistory } from './viewer-local-history.mjs';
import { createCloudReviewReader } from './review/review-sync.mjs';
import { readDraftReview } from './review/draft-review.mjs';
import { readDraftDeckComparison } from './review/draft-decks.mjs';
import { findReviewGame } from './review/review-model.mjs';
import { syncReplays } from './replay-sync.mjs';
import { replayWorker } from './replay-worker.mjs';
import { readReplaySettings, saveReplaySettings, validateReplaySettings, withReplayOperation } from './replay-settings.mjs';
import { retentionPreview } from './replay-retention.mjs';

const defaultViewer = fileURLToPath(new URL('../viewer/dist/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

export async function startReplayServer({ dataDir = defaultDataDir(), viewerDir = defaultViewer, port = 0, cardNames = new Map(), cardMetadata = new Map(), displayNamesZh, cardIdentityResolver, fetchFn = fetch, writeInfo = true, syncWorkflow, collectionUpdate, collectionSync, notifyTask = notifyViewerTask, requestExtension, closeExtension, extraCapabilities = [], replayProvider, enableReplaySync = !replayProvider, enableCollection = enableReplaySync && !replayProvider, includeLocalHistory = enableReplaySync || !replayProvider, observeLocalLogs = includeLocalHistory, autoSyncReplays = false, localHistoryOptions = {}, reviewReader, sourceIdentity = null } = {}) {
  const root = await realpath(resolve(viewerDir)).catch(() => resolve(viewerDir));
  const identityResolver = cardIdentityResolver ?? createCardIdentityResolver();
  const chineseNames = displayNamesZh ?? await loadInstalledChineseDisplayNames();
  let assignedPort, closePromise, closing = false;
  const journal = enableReplaySync || enableCollection ? createTaskJournal(dataDir) : null;
  const sync = createViewerSync({ dataDir, workflow: syncWorkflow ?? syncReplays, notify: notifyTask, journal });
  const collection = createAccountViewerCollections({ dataDir, update: collectionUpdate, sync: collectionSync, notify: notifyTask, journal });
  let queuedAutoSync = null;
  function requestAutoSync() {
    if (queuedAutoSync || closing) return;
    queuedAutoSync = (async () => {
      // A match arriving during another sync must schedule one follow-up,
      // rather than losing its only wake-up when the log stops changing.
      while (sync.snapshot().status === 'running' || collection.snapshot().status === 'running')
        await Promise.all([sync.wait(), collection.wait()]);
      if (!closing && sync.snapshot().status !== 'needs_recovery' && collection.snapshot().status !== 'needs_recovery') sync.start();
    })().finally(() => { queuedAutoSync = null; });
    void queuedAutoSync.catch(() => {});
  }
  const localHistory = includeLocalHistory && observeLocalLogs ? createLocalReplayHistory({ ...localHistoryOptions, dataDir,
    workflow: async options => {
      const imported = await withReplayOperation(dataDir, () =>
        (localHistoryOptions.workflow ?? (options => replayWorker('ingest', options)))(options), { exclusive: false });
      if (autoSyncReplays && enableReplaySync && imported.archive?.archived) requestAutoSync();
      if (imported.status === 'failed') throw Error('Replay publication pending');
      return imported;
    } }) : null;
  const reviews = reviewReader ?? createCloudReviewReader({ loadReplay: replayById, dataDir });
  let landColorCatalog, draftNameCatalog;
  const draftDeckCache = new Map();
  const draftBindingCache = {};
  const workCounters = { history_loads: 0, draft_loads: 0, account_loads: 0 };
  const historyFiles = ['replays.sqlite3', 'replays.sqlite3-wal'];
  const archiveCards = new Map(); let archiveCardsRevision;
  const draftFiles = [...historyFiles, 'draft-capture.sqlite3', 'draft-runs.sqlite3', 'draft-runs.sqlite3-wal',
    'replay-ingest.sqlite3', 'replay-ingest.sqlite3-wal', 'draft-sync/published.json', 'draft-sync/published-bindings.json'];
  const localCatalog = revisionMemo(() => fileRevision(dataDir, historyFiles), async () => {
    workCounters.history_loads++;
    return listReplays({ dataDir, limit: null });
  });
  const draftRunsForDisplay = revisionMemo(() => fileRevision(dataDir, draftFiles), loadDraftRunsForDisplay);
  async function loadAccountCatalog() {
    workCounters.account_loads++;
    const captured = includeLocalHistory && sourceIdentity?.kind !== 'published-history'
      ? await readDraftCapture({ dataDir, metadataOnly: true }) : { accounts: [], active_account: null };
    const accounts = new Map(captured.accounts.map(a => [a.account_key, a]));
    for (const entry of await replayCatalog()) if (validAccountKey(entry.account_key) && !accounts.has(entry.account_key))
      accounts.set(entry.account_key, { account_key: entry.account_key, label: '账号 ' + entry.account_key.slice(0, 8) });
    return { accounts: [...accounts.values()], active_account: captured.active_account };
  }
  const accountCatalog = replayProvider ? loadAccountCatalog :
    revisionMemo(() => fileRevision(dataDir, ['draft-capture.sqlite3', ...historyFiles]), loadAccountCatalog);
  async function catalogRevision() {
    const digest = value => createHash('sha256').update(value).digest('hex');
    if (sourceIdentity?.kind === 'published-history') {
      const revision = digest(JSON.stringify(sourceIdentity));
      return { history: revision, drafts: revision, accounts: revision };
    }
    const [history, drafts, accounts] = await Promise.all([
      fileRevision(dataDir, historyFiles), fileRevision(dataDir, draftFiles), accountCatalog(),
    ]);
    const provider = replayProvider ? JSON.stringify(await replayProvider.list()) : '';
    return { history: digest(history + provider), drafts: digest(drafts), accounts: digest(JSON.stringify(accounts)) };
  }
  async function loadDraftRunsForDisplay() {
    if (!includeLocalHistory || sourceIdentity?.kind === 'published-history') return [];
    workCounters.draft_loads++;
    draftNameCatalog ??= cardNames.size ? Promise.resolve(cardNames) : discoverCardDatabase().then(loadCardNames).catch(() => new Map());
    const history = await localCatalog();
    const ownership = new Map(history.map(item => [item.id, item.account_key]));
    const knownCourses = new Map((await listDraftRuns({ dataDir })).map(run => [run.run_id, run]));
    const sourceCaptures = await listCapturedDraftRuns({ dataDir, cardNames: await draftNameCatalog });
    const localUnknown = await listUnknownDraftRuns({ dataDir, cardNames: await draftNameCatalog });
    let publishedCaptures;
    try { publishedCaptures = await readPublishedDraftLinks(sourceCaptures, { dataDir, history }); }
    catch { publishedCaptures = sourceCaptures.map(run => ({ ...run, binding: 'unresolved', binding_reason: 'evidence_unavailable' })); }
    let bindingUnavailable = false;
    if (publishedCaptures === null) try {
      for (const run of await recentDraftCourses(history, { dataDir, cache: draftBindingCache }))
        knownCourses.set(run.run_id, mergeDraftCourse(knownCourses.get(run.run_id), run));
    } catch { bindingUnavailable = true; } // Saved picks remain readable while derived evidence is unavailable.
    const rawCourses = [...knownCourses.values()].map(run => {
      const keys = new Set(run.matches.map(match => ownership.get(match.id)));
      return { ...run, account_key: keys.size === 1 && validAccountKey([...keys][0]) ? [...keys][0] : null };
    });
    let legacyCaptures;
    if (publishedCaptures === null) {
      const allDecks = await listReplayDecks(rawCourses.flatMap(run => run.matches.map(match => match.id)), { dataDir, cache: draftDeckCache });
      legacyCaptures = bindDraftCaptures(sourceCaptures, verifyDraftCourseMatches(rawCourses, allDecks, ownership));
    }
    let unknownRuns = localUnknown;
    if (unknownRuns.length) try {
      const courses = await recentDraftCourses(history, { dataDir, cache: draftBindingCache });
      const owners = new Map(history.map(item => [item.id, item.account_key]));
      const decks = await cachedDraftDecks(dataDir, history);
      const missingDecks = courses.flatMap(course => course.matches.map(match => match.id)).filter(id => !decks.has(id));
      if (missingDecks.length) for (const [id, deck] of await listReplayDecks(missingDecks, { dataDir, cache: draftDeckCache })) decks.set(id, deck);
      const verifiedCourses = verifyDraftCourseMatches(courses, decks, owners);
      unknownRuns = bindDraftCaptures(unknownRuns, verifiedCourses).map(run =>
        run.binding === 'matched_pool' && validAccountKey(run.binding_account_key)
          ? { ...run, account_key: run.binding_account_key, capture_account_key: null,
            ownership_corrected: true, binding_account_status: 'unknown' }
          : run);
    } catch { /* Unknown local picks remain visible even when local match evidence is unavailable. */ }
    const captures = (publishedCaptures ?? legacyCaptures)
      .map(run => bindingUnavailable && run.binding_reason === 'missing_course' ? { ...run, binding_reason: 'evidence_unavailable' } : run);
    const attached = new Set(captures.filter(run => run.binding === 'matched_pool' && run.binding_account_status === 'matched').map(run => run.bound_run_id));
    const runs = [...rawCourses.filter(run => !attached.has(run.run_id)), ...captures, ...unknownRuns];
    if (!runs.length) return runs;
    const colorRuns = runs.filter(run => run.picks.length);
    if (!colorRuns.length) return runs;
    landColorCatalog ??= discoverCardDatabase().then(loadCardLandColors).catch(() => new Map());
    const latestIds = colorRuns.flatMap(run => [...run.matches].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)) || b.id.localeCompare(a.id)).slice(0, 1).map(match => match.id));
    const decks = await cachedDraftDecks(dataDir, history);
    const missing = latestIds.filter(id => !decks.has(id));
    if (missing.length) for (const [id, deck] of await listReplayDecks(missing, { dataDir, cache: draftDeckCache })) decks.set(id, deck);
    const colored = new Map(withDraftRunLandColors(colorRuns, decks, await landColorCatalog).map(run => [run.run_id, run]));
    return runs.map(run => colored.get(run.run_id) ?? run);
  }
  function send(response, status, value, contentType = 'application/json; charset=utf-8', extraHeaders = {}) {
    response.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer', ...extraHeaders });
    response.end(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value));
  }
  function trustedRequest(request) {
    let host;
    try { host = new URL(`http://${request.headers.host}`); } catch { return false; }
    if (!['127.0.0.1', 'localhost'].includes(host.hostname) || Number(host.port) !== assignedPort) return false;
    if (request.headers.origin) {
      try {
        const origin = new URL(request.headers.origin);
        if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname) || Number(origin.port) !== assignedPort) return false;
      } catch { return false; }
    }
    return request.headers['sec-fetch-site'] !== 'cross-site';
  }
  async function localCard(arenaId) {
    const revision = await fileRevision(dataDir, historyFiles);
    if (revision !== archiveCardsRevision) { archiveCards.clear(); archiveCardsRevision = revision; }
    if (archiveCards.has(arenaId)) return archiveCards.get(arenaId);
    const value = { ...(cardMetadata.get(arenaId) ?? {}), ...(await getArchivedCard(arenaId, { dataDir }) ?? {}),
      ...(cardNames.has(arenaId) ? { name: cardNames.get(arenaId) } : {}) };
    if (archiveCards.size >= 512) archiveCards.delete(archiveCards.keys().next().value);
    archiveCards.set(arenaId, value);
    return value;
  }
  // Keep the immutable coaching source authoritative for its recorded matches.
  // Local log observation adds Viewer history only; it never extends the
  // coach's locked inference corpus or starts model/TTS work.
  async function replayCatalog() {
    const recorded = replayProvider ? await replayProvider.list() : [];
    if (replayProvider && !includeLocalHistory) return recorded;
    const catalog = new Map((await localCatalog()).map(entry => [entry.id, entry]));
    for (const entry of recorded) catalog.set(entry.id, entry);
    return [...catalog.values()].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id.localeCompare(a.id));
  }
  async function replayById(id) {
    const recorded = replayProvider ? await replayProvider.get(id) : null;
    return recorded ?? (includeLocalHistory ? await getReplay(id, { dataDir }) : null);
  }
  const server = createServer(async (request, response) => {
    if (!trustedRequest(request)) return send(response, 403, { error: 'Local replay access only.' });
    try {
      const url = new URL(request.url, `http://127.0.0.1:${assignedPort}`);
      const path = decodeURIComponent(url.pathname);
      if (path === '/api/replay-settings') {
        if (!enableReplaySync) return send(response, 403, { error: 'Settings disabled for this viewer.' });
        if (request.method === 'GET') {
          const days = url.searchParams.get('days');
          const settings = days === null ? await readReplaySettings(dataDir) :
            validateReplaySettings({ retention_days: days === 'all' ? null : Number(days) });
          return send(response, 200, await retentionPreview({ dataDir, settings }));
        }
        if (request.method !== 'POST') return send(response, 405, { error: 'Unsupported settings action.' });
        if (request.headers.origin !== `http://${request.headers.host}` ||
            request.headers['x-mtga-replay-action'] !== 'replay-settings') return send(response, 403, { error: 'Same-origin settings action required.' });
        let body = '';
        for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 1024) return send(response, 413, { error: 'Settings request too large.' }); }
        let settings;
        try { settings = validateReplaySettings(JSON.parse(body)); }
        catch { return send(response, 400, { error: '保留天数须为 1–36500 的整数，或选择不限制。' }); }
        const result = await withReplayOperation(dataDir, async () => {
          await saveReplaySettings(settings, dataDir);
          return replayWorker('retention', { dataDir });
        });
        return send(response, 200, result);
      }
      const account = sourceIdentity?.kind === 'published-history' ? null : url.searchParams.get('account');
      if (account !== null && account !== 'unassigned' && !validAccountKey(account)) return send(response, 400, { error: 'Invalid account scope.' });
      if (path.includes('\0') || path.includes('\\') || path.split('/').includes('..')) return send(response, 400, { error: 'Invalid path.' });
      if (closing && !['GET', 'HEAD'].includes(request.method)) return send(response, 503, { error: 'Replay server is closing.' });
      if (requestExtension && await requestExtension(request, response, url)) return;
      if (closing && !['GET', 'HEAD'].includes(request.method)) return send(response, 503, { error: 'Replay server is closing.' });
      if (/^\/api\/matches\/[^/]+\/review\/(generate|cancel)$/.test(path)) {
        return send(response, 410, { error: '本地模型生成已停用，请检查或同步云端复盘。' });
      }
      const reviewSyncRoute = path.match(/^\/api\/matches\/([^/]+)\/review\/sync$/);
      if (reviewSyncRoute && request.method === 'POST') {
        if (request.headers.origin !== `http://${request.headers.host}` || request.headers['x-mtga-replay-action'] !== 'review-sync') return send(response, 403, { error: 'Same-origin review sync required.' });
        if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0 || url.searchParams.size !== 1 || !/^[1-9][0-9]{0,2}$/.test(url.searchParams.get('game') ?? '')) return send(response, 400, { error: 'Invalid review request.' });
        const gameNumber = Number(url.searchParams.get('game'));
        if (!findReviewGame(await replayById(reviewSyncRoute[1]), gameNumber)) return send(response, 404, { error: 'Unknown game.' });
        const value = reviews.start(reviewSyncRoute[1], gameNumber);
        return send(response, value.code ?? 202, value);
      }
      if ((path === '/api/sync'||path==='/api/sync/reconcile') && !enableReplaySync) return send(response, 403, { error: 'Replay synchronization is disabled in this isolated corpus server.' });
      if ((path === '/api/collection' || path === '/api/collection/sync') && !enableCollection) return send(response, 403, { error: 'Collection updates are disabled in this isolated corpus server.' });
      if ((path === '/api/collection' || path === '/api/collection/sync') && request.method === 'POST') {
        const operation = path.endsWith('/sync') ? 'sync' : 'update';
        if (request.headers.origin !== `http://${request.headers.host}` || request.headers['x-mtga-replay-action'] !== `collection-${operation}`) return send(response, 403, { error: 'Same-origin collection action required.' });
        if (url.searchParams.size !== 1 || !validAccountKey(account) || request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0) return send(response, 400, { error: '请选择已识别的游戏账号后更新收藏。' });
        const catalog = await readDraftCapture({ dataDir, metadataOnly: true });
        if (!catalog.accounts.some(item => item.account_key === account)) return send(response, 400, { error: '收藏账号尚未在本机识别。' });
        if(operation==='update'&&request.headers['x-mtga-replay-account-confirmation']!=='unknown-account-reviewed')return send(response,409,{error:'无法自动识别账户；请确认当前 Arena 账户后再更新。'});
        if (operation === 'update' && catalog.active_account !== account) return send(response, 409, { error: 'Arena 活动账号与所选账号不一致；请在游戏中切换到所选账号后再更新。' });
        if (sync.snapshot().status === 'running') return send(response, 409, { error: 'Replay upload is running; retry after completion.' });
        if(collection.snapshot().status==='needs_recovery'||sync.snapshot().status==='needs_recovery')return send(response,409,{error:'服务中断后的任务需要人工核对，请勿重复上传。'});
        if (collection.snapshot().status === 'running') return collection.snapshot(account).status === 'running'
          ? send(response, 202, collection.snapshot(account))
          : send(response, 409, { error: '另一个账号的收藏任务正在运行。' });
        return send(response, 202, collection.start(operation, account));
      }
      if(path==='/api/sync/reconcile'&&request.method==='POST') {
        if(request.headers.origin!==`http://${request.headers.host}`||request.headers['x-mtga-replay-action']!=='sync-reconcile')return send(response,403,{error:'Same-origin reconciliation required.'});
        if(url.search||request.headers['transfer-encoding']||Number(request.headers['content-length']??0)!==0)return send(response,400,{error:'No parameters accepted.'});
        if(collection.snapshot().status==='running')return send(response,409,{error:'Collection task is running.'});
        return send(response,202,sync.reconcile());
      }
      if (path === '/api/sync' && request.method === 'POST') {
        // No body, paths, repository or command accepted. A non-simple header
        // forces foreign pages through a rejected CORS preflight; also require
        // exact same origin to block forged same-site/cross-origin POSTs.
        if (request.headers.origin !== `http://${request.headers.host}` || request.headers['x-mtga-replay-action'] !== 'sync') return send(response, 403, { error: 'Same-origin replay action required.' });
        if (url.search || request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0) return send(response, 400, { error: 'Replay sync does not accept parameters.' });
        if (collection.snapshot().status === 'running') return send(response, 409, { error: 'Collection update is running; retry after completion.' });
        if(collection.snapshot().status==='needs_recovery'||sync.snapshot().status==='needs_recovery')return send(response,409,{error:'服务中断后的任务需要人工核对，请勿重复上传。'});
        return send(response, 202, sync.start());
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, { error: 'Unsupported replay action.' });
      if (path === '/api/source') return send(response, 200, sourceIdentity);
      if (path === '/api/catalog-revision') return send(response, 200, request.method === 'HEAD' ? '' : await catalogRevision());
      if (path === '/api/local-history') return send(response, 200, request.method === 'HEAD' ? '' : localHistory?.snapshot() ?? { status: 'disabled' });
      if (path === '/api/collection') return send(response, 200, request.method === 'HEAD' ? '' : collection.snapshot(account ?? 'unassigned'));
      if (path === '/api/sync') return send(response, 200, request.method === 'HEAD' ? '' : sync.snapshot());
      if (path === '/api/health') return send(response, 200, { service: 'mtga-gpt-replay', pid: process.pid, port: assignedPort, capabilities: [...(enableReplaySync ? ['replay-sync'] : []), ...(enableCollection ? ['collection-update'] : []), ...extraCapabilities, 'cloud-review-read', 'cloud-review-sync', 'replay-review-read', ...(!requestExtension ? ['replay-only-v1'] : [])] });
      if (path === '/api/accounts') {
        return send(response, 200, await accountCatalog());
      }
      if (path === '/api/matches') return send(response, 200, filterAccount(await replayCatalog(), account));
      const draftDeckRoute = path.match(/^\/api\/draft-runs\/([a-f0-9]{32})\/decks$/);
      if (draftDeckRoute) {
        if (!validAccountKey(account) || url.searchParams.size !== 1) return send(response, 400, { error: '请选择已识别的游戏账号。' });
        const run = filterAccount(await draftRunsForDisplay(), account).find(run => run.run_id === draftDeckRoute[1]);
        if (!run) return send(response, 404, { error: 'Unknown draft in selected account.' });
        const value = await readDraftDeckComparison(run, { dataDir, accountKey: account, displayNamesZh: chineseNames });
        return send(response, 200, request.method === 'HEAD' ? '' : value);
      }
      const draftReviewRoute = path.match(/^\/api\/draft-runs\/([a-f0-9]{32})\/review$/);
      if (draftReviewRoute) {
        if (!validAccountKey(account) || url.searchParams.size !== 1) return send(response, 400, { error: '请选择已识别的游戏账号。' });
        const run = filterAccount(await draftRunsForDisplay(), account).find(run => run.run_id === draftReviewRoute[1]);
        if (!run) return send(response, 404, { error: 'Unknown draft in selected account.' });
        const value = await readDraftReview(run, { dataDir, accountKey: account });
        return send(response, 200, request.method === 'HEAD' ? '' : { ...value, run_id: run.run_id });
      }
      const reviewRoute = path.match(/^\/api\/matches\/([^/]+)\/review$/);
      if (reviewRoute) {
        const gameNumber = Number(url.searchParams.get('game') ?? 1);
        if (!Number.isSafeInteger(gameNumber) || gameNumber < 1 || url.searchParams.size > 1) return send(response, 400, { error: 'Invalid review game.' });
        const value = await reviews.read(reviewRoute[1], gameNumber);
        return send(response, value.code ?? 200, request.method === 'HEAD' ? '' : value);
      }
      if (path === '/api/draft-runs') return send(response, 200, request.method === 'HEAD' ? '' : filterAccount(await draftRunsForDisplay(), account));
      if (path === '/api/matches/latest') {
        if (sourceIdentity?.kind === 'published-history' && replayProvider?.bytes) {
          const bytes = await replayProvider.bytes(sourceIdentity.match_id);
          return send(response, bytes ? 200 : 404, bytes ?? { error: 'No historical match.' });
        }
        const entries = filterAccount(await replayCatalog(), account);
        const replay = replayProvider && !includeLocalHistory ? await replayProvider.latest() : entries.length ? await replayById(entries[0].id) : null;
        return send(response, replay ? 200 : 404, replay ?? { error: 'No archived matches.' });
      }
      const contextRoute = path.match(/^\/api\/matches\/([^/]+)\/context$/);
      if (contextRoute) {
        const gameNumber = Number(url.searchParams.get('game') ?? 1);
        const boundary = url.searchParams.get('boundary') ?? 'after';
        if (!Number.isSafeInteger(gameNumber) || gameNumber < 1 || !['before', 'after'].includes(boundary)) {
          return send(response, 400, { error: 'Invalid context game or boundary.' });
        }
        const replay = await replayById(contextRoute[1]);
        const context = createCoachContext(replay, { gameNumber, anchor: url.searchParams.get('anchor'), boundary });
        if (!context) return send(response, 404, { error: 'Unknown replay context anchor.' });
        const safePart = value => String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
        const filename = `${safePart(context.match_id)}-G${gameNumber}-${safePart(context.anchor)}-${context.state_boundary.startsWith('before') ? 'before' : 'after'}-coach.json`;
        return send(response, 200, request.method === 'HEAD' ? '' : `${JSON.stringify(context, null, 2)}\n`,
          'application/json; charset=utf-8', { 'Content-Disposition': `attachment; filename="${filename}"` });
      }
      const matchRoute = path.match(/^\/api\/matches\/([^/]+)$/);
      if (matchRoute) {
        if (account !== null && !filterAccount([{ account_key: (await replayById(matchRoute[1]))?.match?.account_key }], account).length) return send(response, 404, { error: 'Match is outside the selected account.' });
        if (sourceIdentity?.kind === 'published-history' && replayProvider?.bytes) {
          const bytes = await replayProvider.bytes(matchRoute[1]);
          return send(response, bytes ? 200 : 404, bytes ?? { error: 'Unknown historical match.' });
        }
        const replay = await replayById(matchRoute[1]);
        return send(response, replay ? 200 : 404, replay ?? { error: 'Unknown match.' });
      }
      const cardRoute = path.match(/^\/api\/cards\/(\d+)(\/image)?$/);
      if (cardRoute) {
        const id = Number(cardRoute[1]);
        if (!Number.isSafeInteger(id) || id <= 0) return send(response, 400, { error: 'Invalid card ID.' });
        if (sourceIdentity?.kind === 'published-history') {
          const metadata = cardMetadata.get(id);
          if (!metadata) return send(response, 404, { error: 'Card is not in the published source.' });
          // Historical rules/name fields come only from the verified dictionary.
          // Images are optional local presentation assets, never rules evidence.
          const imageCached = await cardImageIsCached(id, { dataDir });
          if (cardRoute[2]) {
            const image = imageCached ? await getCardImage(id, { dataDir, fetchFn: async () => { throw Error('Historical network disabled'); } }) : null;
            return image ? send(response, 200, image.data, image.contentType, { 'Cache-Control': 'private, max-age=86400' }) : send(response, 404, { error: 'Historical card image unavailable.' });
          }
          return send(response, 200, { ...metadata, display_name_zh: chineseNames.get(id) ?? null,
            metadata_source: 'published-history', source_revision: sourceIdentity.revision,
            image_url: imageCached ? `/api/cards/${id}/image` : null, image_available: imageCached, image_cached: imageCached });
        }
        const options = { dataDir, fetchFn, identityResolver, refreshImage: url.searchParams.get('retry') === '1',
          refreshMetadata: url.searchParams.get('retry') === '1', local: await localCard(id) };
        if (cardRoute[2]) {
          const image = await getCardImage(id, options);
          return image ? send(response, 200, image.data, image.contentType, { 'Cache-Control': options.refreshImage ? 'no-store' : 'private, max-age=86400' }) : send(response, 503, { error: 'Image temporarily unavailable. Use card text.', retry_after: cardImageRetryAfter(id, options) }, 'application/json; charset=utf-8', { 'Retry-After': String(Math.max(1, Math.ceil((cardImageRetryAfter(id, options) - Date.now()) / 1000))) });
        }
        const metadata = await getCardMetadata(id, options);
        return send(response, 200, { ...metadata, display_name_zh: chineseNames.get(id) ?? null,
          image_url: metadata.image_source ? `/api/cards/${id}/image` : null,
          image_error: cardImageFailure(id, options),
          image_retry_after: cardImageRetryAfter(id, options), image_available: Boolean(metadata.image_source), image_cached: await cardImageIsCached(id, { dataDir }) });
      }
      if (path.startsWith('/api/')) return send(response, 404, { error: 'Unknown API route.' });
      const requested = resolve(root, `.${path === '/' ? '/index.html' : path}`);
      if (requested !== root && !requested.startsWith(root + sep)) return send(response, 400, { error: 'Invalid path.' });
      let file;
      try { file = await realpath(requested); } catch (error) {
        if (error.code === 'ENOENT') return send(response, 404, { error: 'Viewer asset not found. Build the viewer first.' });
        throw error;
      }
      if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) return send(response, 403, { error: 'Invalid asset.' });
      const data = await readFile(file);
      return send(response, 200, request.method === 'HEAD' ? Buffer.alloc(0) : data, types[extname(file)] ?? 'application/octet-stream');
    } catch (error) {
      if (error instanceof URIError) return send(response, 400, { error: 'Invalid URL.' });
      send(response, 500, { error: 'Local replay request failed.' });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  assignedPort = server.address().port;
  const url = `http://127.0.0.1:${assignedPort}/`;
  let maintenanceActive = null;
  async function maintainRetention() {
    if (maintenanceActive || !enableReplaySync || closing) return;
    const settings = await readReplaySettings(dataDir);
    if (settings.retention_days === null) return;
    let last = 0;
    try { last = JSON.parse(await readFile(join(dataDir, 'replay-retention-receipt.json'), 'utf8')).checked_at ?? 0; } catch { /* first cleanup */ }
    if (Date.now() - last < 86400000) return;
    maintenanceActive = withReplayOperation(dataDir, () => replayWorker('retention', { dataDir }));
    try { await maintenanceActive; } finally { maintenanceActive = null; }
  }
  const maintenanceTimer = enableReplaySync ? setInterval(() => { void maintainRetention().catch(() => {}); }, 3600000) : null;
  maintenanceTimer?.unref();
  void maintainRetention().catch(() => {});
  if (writeInfo) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeFile(join(dataDir, 'server.json'), JSON.stringify({ pid: process.pid, url, port: assignedPort, viewerDir: root }), { mode: 0o600 });
  }
  localHistory?.start();
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    clearInterval(maintenanceTimer);
    closePromise = (async () => {
      await reviews.close();
      await localHistory?.close();
      await queuedAutoSync;
      await maintenanceActive;
      // Finish a publication before shutting down; don't strand a Git write.
      await closeExtension?.();
      await Promise.all([sync.wait(), collection.wait()]);
      journal?.close();
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (writeInfo) {
        try { if (JSON.parse(await readFile(join(dataDir, 'server.json'), 'utf8')).port === assignedPort) await rm(join(dataDir, 'server.json')); } catch { /* Already removed. */ }
      }
    })();
    return closePromise;
  };
  return { server, url, port: assignedPort, close, localHistory, workCounters: () => ({ ...workCounters }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--data-dir') options.dataDir = args[i + 1];
    else if (args[i] === '--viewer-dir') options.viewerDir = args[i + 1];
    else if (args[i] === '--port') options.port = Number(args[i + 1]);
    else throw new Error(`Unknown server option: ${args[i]}`);
  }
  const running = await startReplayServer(options);
  process.stdout.write(`${running.url}\n`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await running.close(); process.exit(0); });
}
