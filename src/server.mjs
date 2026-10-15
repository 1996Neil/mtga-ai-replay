import { listDraftRuns, withDraftRunLandColors } from './draft-runs.mjs';
import { discoverCardDatabase, loadCardLandColors } from './cards.mjs';
import { createTaskJournal } from './task-journal.mjs';
import { createServer } from 'node:http';
import { readFile, stat, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataDir, listReplays, listReplayDecks, getReplay, getArchivedCard } from './history.mjs';
import { createCardIdentityResolver } from './card-image-identity.mjs';
import { getCardMetadata, getCardImage, cardImageIsCached, cardImageRetryAfter } from './card-cache.mjs';
import { createCoachContext } from './coach-context.mjs';
import { loadInstalledChineseDisplayNames } from './display-names.mjs';
import { createViewerSync } from './viewer-sync.mjs';
import { createViewerCollection } from './viewer-collection.mjs';
import { notifyViewerTask } from './task-notification.mjs';
import { createLocalReplayHistory } from './viewer-local-history.mjs';
import { createCloudReviewReader } from './review/review-sync.mjs';
import { findReviewGame } from './review/review-model.mjs';

const defaultViewer = fileURLToPath(new URL('../viewer/dist/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

export async function startReplayServer({ dataDir = defaultDataDir(), viewerDir = defaultViewer, port = 0, cardNames = new Map(), cardMetadata = new Map(), displayNamesZh, cardIdentityResolver, fetchFn = fetch, writeInfo = true, syncWorkflow, collectionUpdate, collectionSync, notifyTask = notifyViewerTask, requestExtension, closeExtension, extraCapabilities = [], replayProvider, enableReplaySync = !replayProvider, enableCollection = enableReplaySync && !replayProvider, includeLocalHistory = enableReplaySync || !replayProvider, observeLocalLogs = includeLocalHistory, localHistoryOptions = {}, reviewReader, sourceIdentity = null } = {}) {
  const root = await realpath(resolve(viewerDir)).catch(() => resolve(viewerDir));
  const identityResolver = cardIdentityResolver ?? createCardIdentityResolver();
  const chineseNames = displayNamesZh ?? await loadInstalledChineseDisplayNames();
  let assignedPort, closePromise, closing = false;
  const journal = enableReplaySync || enableCollection ? createTaskJournal(dataDir) : null;
  const sync = createViewerSync({ dataDir, workflow: syncWorkflow, notify: notifyTask, journal });
  const collection = createViewerCollection({ dataDir, update: collectionUpdate, sync: collectionSync, notify: notifyTask, journal });
  const localHistory = includeLocalHistory && observeLocalLogs ? createLocalReplayHistory({ ...localHistoryOptions, dataDir }) : null;
  const reviews = reviewReader ?? createCloudReviewReader({ loadReplay: replayById, dataDir });
  let landColorCatalog;
  const draftDeckCache = new Map();
  async function draftRunsForDisplay() {
    if (!includeLocalHistory || sourceIdentity?.kind === 'published-history') return [];
    const runs = await listDraftRuns({ dataDir });
    if (!runs.length) return runs;
    landColorCatalog ??= discoverCardDatabase().then(loadCardLandColors).catch(() => new Map());
    const latestIds = runs.flatMap(run => [...run.matches].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)) || b.id.localeCompare(a.id)).slice(0, 1).map(match => match.id));
    const decks = await listReplayDecks(latestIds, { dataDir, cache: draftDeckCache });
    return withDraftRunLandColors(runs, decks, await landColorCatalog);
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
    return { ...(cardMetadata.get(arenaId) ?? {}), ...(await getArchivedCard(arenaId, { dataDir }) ?? {}),
      ...(cardNames.has(arenaId) ? { name: cardNames.get(arenaId) } : {}) };
  }
  // Keep the immutable coaching source authoritative for its recorded matches.
  // Local log observation adds Viewer history only; it never extends the
  // coach's locked inference corpus or starts model/TTS work.
  async function replayCatalog() {
    const recorded = replayProvider ? await replayProvider.list() : [];
    if (replayProvider && !includeLocalHistory) return recorded;
    const catalog = new Map((await listReplays({ dataDir, limit: null })).map(entry => [entry.id, entry]));
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
        if (url.search || request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0) return send(response, 400, { error: 'Collection update does not accept parameters.' });
        if(operation==='update'&&request.headers['x-mtga-replay-account-confirmation']!=='unknown-account-reviewed')return send(response,409,{error:'无法自动识别账户；请确认当前 Arena 账户后再更新。'});
        if (sync.snapshot().status === 'running') return send(response, 409, { error: 'Replay upload is running; retry after completion.' });
        if(collection.snapshot().status==='needs_recovery'||sync.snapshot().status==='needs_recovery')return send(response,409,{error:'服务中断后的任务需要人工核对，请勿重复上传。'});
        return send(response, 202, collection.start(operation));
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
      if (path === '/api/local-history') return send(response, 200, request.method === 'HEAD' ? '' : localHistory?.snapshot() ?? { status: 'disabled' });
      if (path === '/api/collection') return send(response, 200, request.method === 'HEAD' ? '' : collection.snapshot());
      if (path === '/api/sync') return send(response, 200, request.method === 'HEAD' ? '' : sync.snapshot());
      if (path === '/api/health') return send(response, 200, { service: 'mtga-gpt-replay', pid: process.pid, port: assignedPort, capabilities: [...(enableReplaySync ? ['replay-sync'] : []), ...(enableCollection ? ['collection-update'] : []), ...extraCapabilities, 'cloud-review-read', 'cloud-review-sync', 'replay-review-read', ...(!requestExtension ? ['replay-only-v1'] : [])] });
      if (path === '/api/matches') return send(response, 200, await replayCatalog());
      const reviewRoute = path.match(/^\/api\/matches\/([^/]+)\/review$/);
      if (reviewRoute) {
        const gameNumber = Number(url.searchParams.get('game') ?? 1);
        if (!Number.isSafeInteger(gameNumber) || gameNumber < 1 || url.searchParams.size > 1) return send(response, 400, { error: 'Invalid review game.' });
        const value = await reviews.read(reviewRoute[1], gameNumber);
        return send(response, value.code ?? 200, request.method === 'HEAD' ? '' : value);
      }
      if (path === '/api/draft-runs') return send(response, 200, request.method === 'HEAD' ? '' : await draftRunsForDisplay());
      if (path === '/api/matches/latest') {
        if (sourceIdentity?.kind === 'published-history' && replayProvider?.bytes) {
          const bytes = await replayProvider.bytes(sourceIdentity.match_id);
          return send(response, bytes ? 200 : 404, bytes ?? { error: 'No historical match.' });
        }
        const entries = await replayCatalog();
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
            return image ? send(response, 200, image.data, image.contentType) : send(response, 404, { error: 'Historical card image unavailable.' });
          }
          return send(response, 200, { ...metadata, display_name_zh: chineseNames.get(id) ?? null,
            metadata_source: 'published-history', source_revision: sourceIdentity.revision,
            image_url: imageCached ? `/api/cards/${id}/image` : null, image_available: imageCached, image_cached: imageCached });
        }
        const options = { dataDir, fetchFn, identityResolver, refreshImage: url.searchParams.get('retry') === '1', local: await localCard(id) };
        if (cardRoute[2]) {
          const image = await getCardImage(id, options);
          return image ? send(response, 200, image.data, image.contentType) : send(response, 503, { error: 'Image temporarily unavailable. Use card text.', retry_after: cardImageRetryAfter(id, options) }, 'application/json; charset=utf-8', { 'Retry-After': String(Math.max(1, Math.ceil((cardImageRetryAfter(id, options) - Date.now()) / 1000))) });
        }
        const metadata = await getCardMetadata(id, options);
        return send(response, 200, { ...metadata, display_name_zh: chineseNames.get(id) ?? null,
          image_url: metadata.image_source ? `/api/cards/${id}/image` : null,
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
  if (writeInfo) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeFile(join(dataDir, 'server.json'), JSON.stringify({ pid: process.pid, url, port: assignedPort, viewerDir: root }), { mode: 0o600 });
  }
  localHistory?.start();
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      await reviews.close();
      await localHistory?.close();
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
  return { server, url, port: assignedPort, close, localHistory };
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
