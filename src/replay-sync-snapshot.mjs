import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { coachSyncRunner, getPublishedCoachIndex, atomicSyncWrite } from './coach-sync.mjs';

/** One authenticated query proves repository visibility and current default
 * branch commit. Reuse index bytes only when the exact commit still matches. */
export async function probeReplaySyncRevision(repository, options) {
  const [owner, name] = repository.split('/');
  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){nameWithOwner isPrivate defaultBranchRef{name target{oid}}}}`;
  const output = await coachSyncRunner(options)('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`]);
  return JSON.parse(output).data?.repository;
}
export async function replaySyncSnapshot({ state, dataDir, onProgress, probeRemote = probeReplaySyncRevision, ...options }) {
  const path = join(dataDir, 'replay-sync-snapshot.json');
  let previous;
  try { previous = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous?.repository === state.repository && (!options.runCommand || probeRemote !== probeReplaySyncRevision) &&
      /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(state.repository)) {
    onProgress?.({ phase: 'remote' });
    const remote = await probeRemote(state.repository, options);
    if (!remote?.isPrivate || remote.nameWithOwner !== state.repository) throw Error('Replay sync repository must remain private');
    if (remote.defaultBranchRef?.target?.oid === previous.commit && remote.defaultBranchRef?.name === previous.branch) {
      return { source: 'remote', index: previous.index, commit: previous.commit, pending: state.pending };
    }
  }
  const snapshot = await getPublishedCoachIndex({ ...options, dataDir, fastSync: true, onProgress });
  const branch = String(await coachSyncRunner(options)('git', ['branch', '--show-current'],
    { cwd: join(dataDir, 'coach-sync/repository') })).trim();
  await atomicSyncWrite(path, JSON.stringify({ repository: state.repository, commit: snapshot.commit, index: snapshot.index,
    branch }));
  return snapshot;
}
