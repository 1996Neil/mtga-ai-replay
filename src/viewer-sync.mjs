import {getPublishedCoachIndex} from './coach-sync.mjs';
import { syncReplayHistory, replaySyncError } from './replay-workflow.mjs';
import { createViewerTask } from './viewer-task.mjs';

/** One server-owned upload; the existing publisher lock still protects Git writes. */
export function createViewerSync({ dataDir, workflow = syncReplayHistory, notify, journal, getPublished = getPublishedCoachIndex, reconcile = async job => {
  if(!job.checkpoint?.commit)throw Error('No durable commit checkpoint');
  const remote=await getPublished({dataDir,refresh:true});
  if(remote.source!=='remote'||remote.commit!==job.checkpoint.commit||!job.checkpoint.destination_hash||remote.destination_hash!==job.checkpoint.destination_hash)throw Error('Unverified publication');
  return {status:'succeeded',published:0,updated:0,failed:0,local_matches:null,github_matches:remote.index.matches.length,reconciled:true};
} }) {
  return createViewerTask({ kind: 'replay', notify, journal, reconcile, errorMessage: replaySyncError,
    workflow: ({ onProgress }) => workflow({ dataDir, onProgress }) });
}
