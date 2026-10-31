import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validAccountKey } from './account-scope.mjs';
import { linkText } from './draft-link-contract.mjs';

export const draftOwnershipPath = 'draft-sync/ownership-corrections.json';
const schema = 'MTGA_DRAFT_OWNERSHIP_CORRECTIONS_V1';
const fail = () => { throw Error('Invalid draft ownership correction.'); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Small, explicit repair ledger. Original observations and chunk lineage stay immutable. */
export async function readDraftOwnershipCorrections(dataDir) {
  const path = join(dataDir, draftOwnershipPath);
  let info;
  try { info = await lstat(path); } catch (error) {
    if (error.code === 'ENOENT') return { schema, corrections: [] };
    throw error;
  }
  const parent = await lstat(join(dataDir, 'draft-sync'));
  if (!parent.isDirectory() || parent.isSymbolicLink() || !info.isFile() ||
    info.isSymbolicLink() || info.size > 256 * 1024) fail();
  const text = await readFile(path, 'utf8'), value = JSON.parse(text);
  if (linkText(value) !== text || !exact(value, ['schema', 'corrections']) || value.schema !== schema ||
    !Array.isArray(value.corrections) || value.corrections.length > 1000) fail();
  const used = new Set();
  for (const row of value.corrections) {
    if (!exact(row, ['sources', 'source_account_key', 'account_key']) ||
      !validAccountKey(row.source_account_key) || !validAccountKey(row.account_key) ||
      row.source_account_key === row.account_key || !Array.isArray(row.sources) ||
      !row.sources.length || row.sources.length > 1000) fail();
    for (const source of row.sources) {
      if (!exact(source, ['run_id', 'sha256']) || !/^[a-f0-9]{32}$/.test(source.run_id) ||
        !/^[a-f0-9]{64}$/.test(source.sha256) || used.has(source.run_id)) fail();
      used.add(source.run_id);
    }
  }
  return value;
}

/** Revalidate against this publication, never a later login or an adjacent timestamp. */
export function draftOwnershipCorrection(row, sourceAccount, ledger) {
  const repair = ledger.corrections.find(value => value.source_account_key === sourceAccount &&
    value.sources.some(source => source.run_id === row.run_id));
  if (!repair || row.status !== 'linked' || !row.matches.length ||
    row.matches.some(match => match.account_key !== repair.account_key) ||
    row.sources.length !== repair.sources.length ||
    row.sources.some(source => !repair.sources.some(ref => ref.run_id === source.run_id && ref.sha256 === source.sha256))) return null;
  return { account_key: repair.account_key, method: 'verified_pool_and_match_identity' };
}

/** Plan only from already source-validated, published relationships with one known owner. */
export function planDraftOwnershipCorrections(runs, documents, runIds, previous) {
  if (!runIds.length || new Set(runIds).size !== runIds.length) fail();
  const corrections = [...previous.corrections];
  for (const id of runIds) {
    const run = runs.find(value => value.run_id === id);
    const existing = previous.corrections.find(value => value.sources.some(source => source.run_id === id));
    const doc = documents?.[existing?.source_account_key ?? run?.account_key];
    const row = doc?.runs.find(value => value.run_id === id);
    if (existing && run?.binding === 'matched_pool' &&
      draftOwnershipCorrection(row ?? {}, existing.source_account_key, previous) &&
      run.binding_account_key === existing.account_key && run.matches.length === row.matches.length &&
      run.matches.every(match => match.account_key === existing.account_key)) continue;
    if (!run || run.binding !== 'matched_pool' || run.binding_account_status !== 'conflict' ||
      !validAccountKey(run.binding_account_key) || !row || row.status !== 'linked' ||
      row.matches.some(match => match.account_key !== run.binding_account_key) ||
      run.matches.length !== row.matches.length ||
      row.matches.some(match => !run.matches.some(current => current.id === match.id && current.account_key === match.account_key)) ||
      corrections.some(value => value.sources.some(source => row.sources.some(ref => ref.run_id === source.run_id)))) fail();
    corrections.push({ sources: row.sources.map(source => ({ ...source })),
      source_account_key: run.account_key, account_key: run.binding_account_key });
  }
  return { schema, corrections };
}
