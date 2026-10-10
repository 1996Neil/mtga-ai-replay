import { updateCollection, syncCollection, collectionErrorMessage } from './collection-update.mjs';
import { createViewerTask } from './viewer-task.mjs';

/** Invoke the same existing validated snapshot/publisher path as the installed CLI. */
export function createViewerCollection({ dataDir, update = updateCollection, sync = syncCollection, notify }) {
  let savedLocalResult;
  return createViewerTask({ kind: 'collection', notify, errorMessage: collectionErrorMessage,
    workflow: async ({ operation, onProgress }) => {
      onProgress({ phase: operation === 'sync' ? 'uploading' : 'reading' });
      let result;
      try { result = await (operation === 'sync' ? sync : update)({ dataDir, readerOptions: { interactive: false } }); }
      catch (error) {
        if (operation === 'sync' && savedLocalResult) return { ...savedLocalResult, status: 'partial', synced: false, error: collectionErrorMessage(error) };
        throw error;
      }
      const summary = result.summary ?? {}, inventory = result.inventory ?? {};
      const normalized = { status: result.synced ? 'succeeded' : result.local_updated ? 'partial' : 'failed',
        local_updated: Boolean(result.local_updated), synced: Boolean(result.synced), error: result.sync_error ?? null,
        summary: { card_kinds: summary.card_kinds, total_quantity: summary.total_quantity, read_at: summary.read_at, verified_at: summary.verified_at },
        inventory: { gold: inventory.gold, gems: inventory.gems, wildcards: inventory.wildcards },
      };
      if (result.local_updated) savedLocalResult = normalized;
      return normalized;
    } });
}
