import { updateCollection, syncCollection, collectionErrorMessage } from './collection-update.mjs';
import { createViewerTask } from './viewer-task.mjs';
import { collectionAccountKey } from './collection-scope.mjs';
import { validAccountKey } from './account-scope.mjs';

/** Invoke the same existing validated snapshot/publisher path as the installed CLI. */
export function createViewerCollection({ dataDir, displayNamesZh, update = updateCollection, sync = syncCollection, notify, journal, accountKey }) {
  let savedLocalResult;
  return createViewerTask({ kind: 'collection', notify, journal, errorMessage: collectionErrorMessage,
    workflow: async ({ operation, onProgress }) => {
      onProgress({ phase: operation === 'sync' ? 'uploading' : 'reading' });
      let result;
      try { result = await (operation === 'sync' ? sync : update)({ dataDir, displayNamesZh, accountKey, confirmAccount:true, readerOptions: { interactive: false } }); }
      catch (error) {
        if (operation === 'sync' && savedLocalResult) return { ...savedLocalResult, status: 'partial', synced: false, error: collectionErrorMessage(error) };
        throw error;
      }
      const summary = result.summary ?? {}, inventory = result.inventory ?? {};
      const normalized = { status: result.synced ? 'succeeded' : result.local_updated ? 'partial' : 'failed',
        ...(accountKey ? { account_key: accountKey } : {}),
        local_updated: Boolean(result.local_updated), synced: Boolean(result.synced), error: result.sync_error ?? null,
        summary: { card_kinds: summary.card_kinds, total_quantity: summary.total_quantity, read_at: summary.read_at, verified_at: summary.verified_at },
        inventory: { gold: inventory.gold, gems: inventory.gems, wildcards: inventory.wildcards },
      };
      if (result.local_updated) savedLocalResult = normalized;
      return normalized;
    } });
}

/** One shared reader/publisher, isolated task receipts for each explicitly selected account. */
export function createAccountViewerCollections(options) {
  const tasks = new Map();
  const legacy = createViewerCollection(options);
  function task(key) {
    collectionAccountKey(key);
    if (!key) return legacy;
    if (!tasks.has(key)) {
      const journal = options.journal && {
        load: kind => options.journal.load(`${kind}:${key}`),
        save: (kind, job) => options.journal.save(`${kind}:${key}`, job),
      };
      tasks.set(key, createViewerCollection({ ...options, journal, accountKey: key }));
    }
    return tasks.get(key);
  }
  for (const kind of options.journal?.kinds?.() ?? []) {
    if (kind.startsWith('collection:') && validAccountKey(kind.slice(11))) task(kind.slice(11));
  }
  const all = () => [legacy, ...tasks.values()];
  function busySnapshot() {
    const jobs = all().map(value => value.snapshot());
    return jobs.find(job => job.status === 'running') ?? jobs.find(job => job.status === 'needs_recovery') ?? { id: null, status: 'idle' };
  }
  return {
    snapshot(key) {
      if (key !== undefined) {
        if (key === 'unassigned') return { ...legacy.snapshot(), account_key: null };
        return { ...task(key).snapshot(), account_key: key };
      }
      return busySnapshot();
    },
    start(operation, key) {
      if (!validAccountKey(key)) throw Object.assign(new Error('Select an account'), { code: 'COLLECTION_ACCOUNT_INVALID' });
      const busy = busySnapshot();
      if (busy.status === 'running') return task(key).snapshot().status === 'running' ? { ...task(key).snapshot(), account_key: key } : null;
      if (busy.status === 'needs_recovery') return null;
      return { ...task(key).start(operation), account_key: key };
    },
    wait: () => Promise.all(all().map(value => value.wait())),
  };
}
