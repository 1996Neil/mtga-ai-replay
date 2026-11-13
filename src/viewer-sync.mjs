import {getPublishedCoachIndex, assertPublishedCheckpointCommit, settlePublishedPending} from './coach-sync.mjs';
import { syncReplayHistory, replaySyncError } from './replay-workflow.mjs';
import { createViewerTask } from './viewer-task.mjs';

/** One server-owned upload; the existing publisher lock still protects Git writes. */
export function createViewerSync({ dataDir, workflow = syncReplayHistory, notify, journal, getPublished = getPublishedCoachIndex, reconcile = async job => {
  if(!job.checkpoint?.commit)throw Error('No durable commit checkpoint');
  // The draft publisher shares this repository and lock; wait briefly for it
  // instead of reporting an unverifiable outcome.
  const remote=await getPublished({dataDir,refresh:true,waitForSync:true,syncWaitTimeoutMs:120000});
  if(remote.source!=='remote'||!job.checkpoint.destination_hash||remote.destination_hash!==job.checkpoint.destination_hash)throw Error('Unverified publication');
  // The branch head can move on after the checkpoint (the draft publisher
  // shares it). Verified content and commit ancestry are the evidence, not
  // exact head equality.
  const published=new Map((remote.index?.matches??[]).map(match=>[match.match_id,match.content_hash]));
  if((remote.pending??[]).some(item=>published.get(item.match_id)!==item.content_hash))throw Error('Unverified publication');
  if(remote.commit!==job.checkpoint.commit)await assertPublishedCheckpointCommit(job.checkpoint.commit,{dataDir,branch:remote.branch});
  if(remote.pending?.length)await settlePublishedPending({dataDir,index:remote.index});
  return {status:'succeeded',published:0,updated:0,failed:0,local_matches:null,github_matches:remote.index.matches.length,reconciled:true};
} }) {
  return createViewerTask({ kind: 'replay', notify, journal, reconcile, errorMessage: replaySyncError,
    workflow: ({ onProgress }) => workflow({ dataDir, onProgress }) });
}
