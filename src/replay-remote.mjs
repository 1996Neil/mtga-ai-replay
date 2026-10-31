import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createGitBatch } from './git-batch.mjs';
import { readPublishedReviewSource } from './review/cloud-review.mjs';
import { archiveReplays, listReplays, getReplay, isReplayExcluded, listReplaySummaries } from './history.mjs';
import { replayInRetention, readReplaySettings } from './replay-settings.mjs';
import { atomicSyncWrite } from './coach-sync.mjs';
import { buildCoachBundle } from './coach-bundle.mjs';

const execute = promisify(execFile);
export async function importRemoteReplays({ dataDir, snapshot, baselines = {} }) {
  if (snapshot.source !== 'remote' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(snapshot.commit ?? '')) throw Error('Unverified remote index');
  const settings = await readReplaySettings(dataDir);
  let receipts = {};
  try { receipts = JSON.parse(await readFile(join(dataDir, 'replay-remote-receipts.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const local = new Map((await listReplays({ dataDir, limit: null })).map(match => [match.id, match]));
  receipts = { ...baselines, ...receipts };
  // A successfully uploaded version takes precedence over an older download receipt.
  for (const [id, baseline] of Object.entries(baselines)) if (baseline.uploaded) receipts[id] = baseline;
  const candidates = snapshot.index.matches.filter(entry => replayInRetention(entry, settings) &&
    (!local.has(entry.match_id) || receipts[entry.match_id] && receipts[entry.match_id].content_hash !== entry.content_hash));
  let downloaded = 0;
  const remoteRevisions = {};
  const conflicts = [];
  const cwd = join(dataDir, 'coach-sync/repository'), batch = createGitBatch({ cwd,
    env: { GIT_DIR: join(cwd, '.git'), GIT_WORK_TREE: cwd, GIT_INDEX_FILE: join(cwd, '.git/index') } });
  try {
    for (const entry of candidates) {
      if (await isReplayExcluded(entry.match_id, { dataDir })) continue;
      if (!/^matches\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry.path ?? '')) throw Error('Invalid remote match path');
      const bothChanged = local.has(entry.match_id) &&
        local.get(entry.match_id).replay_revision !== receipts[entry.match_id]?.local_revision;
      const { stdout } = await execute('git', ['ls-tree', '-rz', snapshot.commit, '--', entry.path], { cwd, maxBuffer: 1024 * 1024 });
      const objects = new Map(stdout.split('\0').filter(Boolean).map(row => {
        const [meta, path] = row.split('\t'), [mode, type, oid] = meta.split(' ');
        if (!['100644', '100755'].includes(mode) || type !== 'blob') throw Error('Invalid remote blob');
        return [path, oid];
      }));
      const read = async path => {
        const oid = objects.get(path);
        if (!oid) throw Error('Missing remote blob');
        const check = (await batch.run(['cat-file', '--batch-check'], { input: Buffer.from(oid + '\n') })).toString();
        const size = Number(check.match(/ blob ([0-9]+)\n$/)?.[1]);
        if (!Number.isSafeInteger(size) || size > 2 * 1024 * 1024) throw Error('Remote blob too large');
        const bytes = await batch.run(['cat-file', '--batch'], { input: Buffer.from(oid + '\n') });
        return bytes.subarray(bytes.indexOf(10) + 1, bytes.length - 1).toString('utf8');
      };
      const manifestPath = `${entry.path}/manifest.json`, manifestBytes = await read(manifestPath);
      const manifest = JSON.parse(manifestBytes), names = Object.keys(manifest.files ?? {});
      if (names.length > 515) throw Error('Remote manifest too large');
      const files = new Map([['index.json', JSON.stringify(snapshot.index)], [manifestPath, manifestBytes]]);
      for (const name of names) files.set(name.startsWith('matches/') ? name : `${entry.path}/${name}`,
        await read(name.startsWith('matches/') ? name : `${entry.path}/${name}`));
      const source = readPublishedReviewSource({ files, matchId: entry.match_id, revision: snapshot.commit });
      if (bothChanged) {
        // A completed single-match upload can precede its download receipt.
        // Only exact full-content equality can reconcile that apparent conflict.
        const before = local.get(entry.match_id).replay_revision;
        const replay = await getReplay(entry.match_id, { dataDir });
        const coach = JSON.parse(files.get(`${entry.path}/coach.json`));
        const rebuilt = await buildCoachBundle(replay, { cards: source.cards,
          historyKey: source.history_key, multipart: Boolean(coach.reference_encoding) });
        const current = (await listReplaySummaries([entry.match_id], { dataDir }))[0];
        if (current?.replay_revision !== before || rebuilt.contentHash !== entry.content_hash) {
          conflicts.push({ match_id: entry.match_id, reason: '本地和线上均有修改，已保留本地版本。' }); continue;
        }
        receipts[entry.match_id] = { content_hash: entry.content_hash, local_revision: before };
        remoteRevisions[entry.match_id] = before;
        await atomicSyncWrite(join(dataDir, 'replay-remote-receipts.json'), JSON.stringify(receipts));
        continue;
      }
      const result = await archiveReplays([source.replay], { dataDir, replaceRevision: receipts[entry.match_id]?.local_revision });
      if (result.conflicts) { conflicts.push({ match_id: entry.match_id, reason: '本地版本已变化，未覆盖。' }); continue; }
      const revision = result.revisions[entry.match_id];
      if (revision) {
        receipts[entry.match_id] = { content_hash: entry.content_hash, local_revision: revision };
        remoteRevisions[entry.match_id] = revision;
        await atomicSyncWrite(join(dataDir, 'replay-remote-receipts.json'), JSON.stringify(receipts));
        downloaded += result.archived;
      }
    }
  } finally { await batch.close(); }
  await atomicSyncWrite(join(dataDir, 'replay-remote-receipts.json'), JSON.stringify(receipts));
  return { downloaded, conflicts, remote_revisions: remoteRevisions };
}
