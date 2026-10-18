import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { defaultDataDir, listReplays } from './history.mjs';
import { prepareCoachReplayUpload } from './coach-catalog-sync.mjs';
import { getPublishedCoachIndex, syncCoachBundles, verifyCoachReplayReceipt, assertCoachSyncBinding, CoachSyncError } from './coach-sync.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const RETRYABLE = new Set(['GITHUB_UNAVAILABLE', 'GIT_FAILED', 'SYNC_BUSY']);
const terminal = new Set(['succeeded', 'baseline', 'skipped_tutorial']);
function fail(code, message) { throw new CoachSyncError(code, message); }
function validMatch(match) {
  return typeof match?.id === 'string' && match.id.length > 0 && match.id.length <= 256 &&
    !/[\x00-\x1f]/.test(match.id) && Number.isFinite(Date.parse(match.started_at)) &&
    ['Win', 'Loss', 'Draw'].includes(match.result) && match.step_count > 0;
}
function livePid(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

/** Local-only durable cursor + work ledger. The session claim serializes two
 * server processes; a reused/unknown PID fails closed instead of stealing work.
 * No replay payload, raw log, credential, path or exception text enters rows. */
function openLedger(dataDir, binding) {
  const root = join(resolve(dataDir), 'tasks');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw Error('Unsafe upload ledger');
  const path = join(root, 'replay-auto-upload.sqlite3');
  for (const name of [path, path + '-wal', path + '-shm']) {
    try { const info = lstatSync(name); if (info.isSymbolicLink() || !info.isFile()) throw Error('Unsafe upload ledger'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const db = new DatabaseSync(path), token = randomUUID();
  chmodSync(path, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work (match_id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const get = key => { const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; };
  const set = (key, value) => db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  const save = row => db.prepare('INSERT INTO work VALUES (?,?) ON CONFLICT(match_id) DO UPDATE SET value=excluded.value').run(row.match_id, JSON.stringify(row));
  const rows = () => db.prepare('SELECT value FROM work ORDER BY rowid').all().map(row => JSON.parse(row.value));
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  try {
    transaction(() => {
      const owner = get('owner');
      if (owner && livePid(owner.pid)) fail('AUTO_UPLOAD_BUSY', 'Another automatic upload owner is active or unverified.');
      const previous = get('binding');
      if (previous && previous !== hash(binding)) fail('SYNC_BINDING', 'The upload queue requires an explicit local repository rebind.');
      set('binding', hash(binding)); set('owner', { pid: process.pid, token });
      for (const row of rows()) {
        if (row.status === 'publishing') save({ ...row, status: 'needs_recovery', next_attempt_at: 0 });
        if (row.status === 'preparing') save({ ...row, status: 'queued', next_attempt_at: 0 });
      }
    });
  } catch (error) { db.close(); throw error; }
  return { get, set, save, rows, transaction,
    close() { transaction(() => { if (get('owner')?.token === token) db.prepare("DELETE FROM metadata WHERE key='owner'").run(); }); db.close(); },
  };
}

/** All network writes remain in the existing validated Git publisher. */
export function createReplayUploadTransport({ dataDir, binding, ...options }) {
  const settings = { ...options, dataDir, expectedBinding: binding };
  return {
    list: () => listReplays({ dataDir, limit: null }),
    inspect: matchId => getPublishedCoachIndex({ ...settings, onlyMatchIds: [matchId ?? '__activation__'] }),
    prepare: (matchId, snapshot) => prepareCoachReplayUpload(matchId, { ...settings, snapshot, requireFinalized: true }),
    publish: (receipt, onProgress) => syncCoachBundles({ ...settings, onlyMatchIds: [receipt.match_id], expectedReceipt: receipt, onProgress }),
    verify: receipt => verifyCoachReplayReceipt(receipt, settings),
  };
}

/** Even disabled automatic mode must not let the manual button blindly replay
 * a previously interrupted publication. Reading this guard creates no files. */
export function hasUnverifiedReplayAutoUpload(dataDir = defaultDataDir()) {
  const path = join(resolve(dataDir), 'tasks', 'replay-auto-upload.sqlite3');
  let db;
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) return true;
    db = new DatabaseSync(path, { readOnly: true });
    return db.prepare('SELECT value FROM work').all().some(row =>
      ['publishing', 'needs_recovery'].includes(JSON.parse(row.value).status));
  } catch (error) { return error.code !== 'ENOENT'; }
  finally { db?.close(); }
}

/** Source-only opt-in controller. No caller is enabled by default. The supplied
 * binding must come from deliberate local activation, never HTTP input. */
export function createReplayAutoUpload({ dataDir = defaultDataDir(), enabled = false, binding,
  transport, transportOptions = {}, isBusy = () => false, now = Date.now,
  pollIntervalMs = 30000, retryBaseMs = 30000, retryMaxMs = 15 * 60_000 } = {}) {
  if (!enabled) return { snapshot: () => ({ status: 'disabled', enabled: false }), check: async () => ({ status: 'disabled', enabled: false }), start() {}, close: async () => {} };
  assertCoachSyncBinding({ id: binding?.repository_id, nameWithOwner: binding?.repository, defaultBranchRef: { name: binding?.branch } }, binding ?? {});
  if (![pollIntervalMs, retryBaseMs, retryMaxMs].every(value => Number.isSafeInteger(value) && value >= 10) || retryMaxMs < retryBaseMs) throw Error('Invalid automatic upload retry budget');
  // Copy only the bounded destination, never retain extra configuration fields.
  binding = { repository: binding.repository, repository_id: binding.repository_id, branch: binding.branch };
  const ledger = openLedger(dataDir, binding), io = transport ?? createReplayUploadTransport({ ...transportOptions, dataDir, binding });
  let active = null, timer = null, closed = false, status = 'idle', error = null, finalSnapshot = null;
  const snapshot = () => {
    if (finalSnapshot) return finalSnapshot;
    const rows = ledger.rows().filter(row => row.status !== 'baseline');
    return { enabled: true, status, initialized: Boolean(ledger.get('activation')), binding_verified: ledger.get('activation')?.verified === true, busy: Boolean(active), error,
      queued: rows.filter(row => ['queued', 'preparing', 'prepared', 'publishing'].includes(row.status)).length,
      needs_recovery: rows.filter(row => row.status === 'needs_recovery').length,
      issues: rows.filter(row => ['blocked', 'needs_recovery'].includes(row.status)).slice(0, 20).map(row => ({ match_id: row.match_id, status: row.status, code: row.error_code })),
      skipped_tutorial: rows.filter(row => row.status === 'skipped_tutorial').length,
      blocked: rows.filter(row => row.status === 'blocked').length,
      waiting_source: rows.filter(row => row.status === 'waiting_source').length,
      succeeded: rows.filter(row => row.status === 'succeeded').length };
  };
  const defer = (row, nextStatus, code) => {
    const attempts = (row.attempts ?? 0) + 1;
    ledger.save({ ...row, status: nextStatus, attempts, error_code: /^[A-Z_]{1,64}$/.test(code ?? '') ? code : 'AUTO_UPLOAD_UNVERIFIED',
      next_attempt_at: now() + Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(attempts - 1, 20)) });
  };
  function acknowledge(row, receipt) {
    if (receipt?.verified !== true || receipt.content_hash !== row.receipt.content_hash ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(receipt.commit ?? '')) fail('SYNC_REMOTE_VERIFY', 'Automatic upload receipt is unverified.');
    ledger.save({ ...row, status: 'succeeded', verified_commit: receipt.commit, error_code: null, next_attempt_at: null });
  }
  async function run() {
    if (closed) return;
    status = 'running'; error = null;
    try {
      // No imports or external writes occur from status reads. Initialization is
      // invoked only after the local observer's initial successful import.
      const catalog = (await io.list()).filter(validMatch);
      if (!ledger.get('activation')) {
        // Preserve the consent/initial-import boundary even while offline. Remote
        // readiness is separate: no publication can precede verified preflight.
        ledger.transaction(() => {
          for (const match of catalog) ledger.save({ match_id: match.id, started_at: match.started_at, status: 'baseline' });
          ledger.set('activation', { at: now(), verified: false });
        });
      }
      const activation = ledger.get('activation'), known = new Map(ledger.rows().map(row => [row.match_id, row]));
      ledger.transaction(() => {
        for (const match of catalog) {
          const previous = known.get(match.id), ready = match.auto_upload_ready === true;
          if (!previous) ledger.save({ match_id: match.id, started_at: match.started_at,
            status: Date.parse(match.started_at) < activation.at ? 'baseline' : ready ? 'queued' : 'waiting_source', attempts: 0, next_attempt_at: 0 });
          else if (previous.status === 'waiting_source' && ready && previous.started_at === match.started_at) {
            ledger.save({ ...previous, status: 'queued', next_attempt_at: 0 });
          }
        }
      });
      if (isBusy()) { status = 'waiting'; return; }
      if (!activation.verified) {
        await io.inspect(null); // Private repository + stable ID + branch + clean ownership.
        ledger.set('activation', { ...activation, verified: true });
      }
      // Any interrupted/unknown write blocks new publications, but permits
      // bounded read-only reconciliation of the exact retained bundle.
      const rows = ledger.rows(), uncertain = rows.filter(row => row.status === 'needs_recovery');
      for (const row of uncertain) {
        if ((row.next_attempt_at ?? 0) > now()) continue;
        try {
          if (!row.receipt) fail('SYNC_REMOTE_VERIFY', 'A durable bundle receipt is unavailable.');
          acknowledge(row, await io.verify(row.receipt));
        } catch (failure) { defer(row, 'needs_recovery', failure.code); }
      }
      if (ledger.rows().some(row => ['needs_recovery', 'blocked'].includes(row.status))) { status = 'needs_attention'; return; }
      // A previously prepared receipt owns the publisher lane even if an older
      // waiting-source row has just finalized. Row insertion order is not ownership.
      const work = ledger.rows().sort((a, b) =>
        Number(Boolean(b.receipt) && !terminal.has(b.status)) - Number(Boolean(a.receipt) && !terminal.has(a.status)));
      for (let row of work) {
        if (closed || isBusy()) break;
        if (terminal.has(row.status) || row.status === 'waiting_source') continue;
        // A prepared bundle owns the lane through its backoff. Advancing another
        // match would conflict with this durable pending publication.
        if ((row.next_attempt_at ?? 0) > now()) break;
        let checkpoint = null;
        try {
          const remote = await io.inspect(row.match_id);
          if (!row.receipt) {
            ledger.save({ ...row, status: 'preparing' });
            const prepared = await io.prepare(row.match_id, remote);
            if (prepared?.match_id !== row.match_id || prepared.started_at !== row.started_at ||
                !/^[a-f0-9]{64}$/.test(prepared.content_hash ?? '') || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(prepared.history_key ?? '')) {
              fail('SYNC_STATE', 'Prepared automatic replay identity is invalid.');
            }
            row = { ...row, status: 'prepared', receipt: { match_id: prepared.match_id, started_at: prepared.started_at,
              history_key: prepared.history_key, content_hash: prepared.content_hash } };
            ledger.save(row);
          }
          // Manual fallback may have completed this same item while we waited.
          const published = await io.verify(row.receipt);
          if (published.verified) { acknowledge(row, published); continue; }
          ledger.save({ ...row, status: 'publishing' });
          await io.publish(row.receipt, progress => {
            if (!progress?.checkpoint) return;
            checkpoint = progress.checkpoint;
            ledger.save({ ...row, status: 'publishing', checkpoint: {
              commit: checkpoint.commit, destination_hash: checkpoint.destination_hash } });
          });
          // An independent remote readback is required even after transport success.
          row = { ...row, status: 'needs_recovery' }; ledger.save(row);
          acknowledge(row, await io.verify(row.receipt));
        } catch (failure) {
          const safeRetry = !checkpoint && row.status !== 'needs_recovery' && RETRYABLE.has(failure.code);
          const next = checkpoint || row.status === 'needs_recovery' || !failure.code ? 'needs_recovery' : failure.code === 'SYNC_TUTORIAL_EXCLUDED' ? 'skipped_tutorial' : failure.code === 'SYNC_SOURCE_PENDING' ? 'waiting_source' : safeRetry ? 'queued' : 'blocked';
          defer({ ...row, ...(checkpoint ? { checkpoint } : {}) }, next, failure.code);
          if (next !== 'skipped_tutorial') break;
        }
      }
      status = ledger.rows().some(row => ['needs_recovery', 'blocked'].includes(row.status)) ? 'needs_attention' : 'idle';
    } catch (failure) {
      status = RETRYABLE.has(failure.code) ? 'offline' : 'needs_attention';
      error = '自动上传暂未完成；本地回放和待传队列已保留。';
    }
  }
  function check() {
    if (closed) return Promise.resolve({ status: 'closed', enabled: false });
    if (!active) active = run().finally(() => { active = null; });
    return active.then(snapshot);
  }
  return { snapshot, check,
    start() { if (timer || closed) return; timer = setInterval(() => { void check(); }, pollIntervalMs); timer.unref?.(); },
    async close() { if (closed) return; closed = true; clearInterval(timer); await active; finalSnapshot = { ...snapshot(), status: 'closed', enabled: false, busy: false }; ledger.close(); },
  };
}
