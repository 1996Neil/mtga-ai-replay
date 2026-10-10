import { syncReplayHistory, replaySyncError } from './replay-workflow.mjs';
import { createViewerTask } from './viewer-task.mjs';

/** One server-owned upload; the existing publisher lock still protects Git writes. */
export function createViewerSync({ dataDir, workflow = syncReplayHistory, notify }) {
  return createViewerTask({ kind: 'replay', notify, errorMessage: replaySyncError,
    workflow: ({ onProgress }) => workflow({ dataDir, onProgress }) });
}
