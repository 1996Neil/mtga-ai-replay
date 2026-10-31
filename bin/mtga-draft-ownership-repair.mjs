#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultDataDir, listReplays } from '../src/history.mjs';
import { listCapturedDraftRuns } from '../src/draft-capture.mjs';
import { readPublishedDraftLinks } from '../src/draft-publication.mjs';
import { draftOwnershipPath, readDraftOwnershipCorrections, planDraftOwnershipCorrections } from '../src/draft-ownership.mjs';
import { withCoachSyncLock, safeSyncOutputParents, atomicSyncWrite } from '../src/coach-sync.mjs';
import { linkText } from '../src/draft-link-contract.mjs';

const { values } = parseArgs({ options: {
  'data-dir': { type: 'string' }, run: { type: 'string', multiple: true },
  apply: { type: 'boolean', default: false },
} });
try {
  const dataDir = values['data-dir'] ?? defaultDataDir();
  const plan = async () => {
    const source = await listCapturedDraftRuns({ dataDir });
    const runs = await readPublishedDraftLinks(source, { dataDir, history: await listReplays({ dataDir, limit: null }) });
    const saved = JSON.parse(await readFile(join(dataDir, 'draft-sync/published-bindings.json'), 'utf8'));
    const previous = await readDraftOwnershipCorrections(dataDir);
    const next = planDraftOwnershipCorrections(runs ?? [], saved.documents, values.run ?? [], previous);
    if (values.apply) {
      await safeSyncOutputParents(dataDir, draftOwnershipPath);
      await atomicSyncWrite(join(dataDir, draftOwnershipPath), linkText(next));
    }
    return { status: values.apply ? 'queued_for_publication' : 'preview',
      corrected_runs: next.corrections.length - previous.corrections.length,
      corrected_segments: next.corrections.slice(previous.corrections.length).reduce((sum, row) => sum + row.sources.length, 0),
      original_observations_unchanged: true };
  };
  const result = values.apply ? await withCoachSyncLock(dataDir, plan) : await plan();
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error?.code === 'SYNC_BUSY' ? 'A data sync is running; retry ownership repair after it finishes.' :
    'Draft ownership repair refused; published identity/source evidence must match exactly.');
  process.exitCode = 1;
}
