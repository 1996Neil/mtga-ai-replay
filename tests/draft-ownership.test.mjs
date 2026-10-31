import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftOwnershipCorrection, planDraftOwnershipCorrections, readDraftOwnershipCorrections,
  draftOwnershipPath } from '../src/draft-ownership.mjs';
import { linkText } from '../src/draft-link-contract.mjs';
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const source = { run_id: '1'.repeat(32), sha256: '2'.repeat(64) };
const empty = { schema: 'MTGA_DRAFT_OWNERSHIP_CORRECTIONS_V1', corrections: [] };
const row = { run_id: source.run_id, sources: [source], status: 'linked', matches: [{ id: 'match', account_key: B }] };
const run = { run_id: source.run_id, account_key: A, binding: 'matched_pool',
  binding_account_status: 'conflict', binding_account_key: B, matches: row.matches };
const doc = { [A]: { runs: [row] } };

test('repair requires complete published relationship and exact source/owner evidence; a later login cannot authorize it', () => {
  const ledger = planDraftOwnershipCorrections([run], doc, [run.run_id], empty);
  assert.equal(draftOwnershipCorrection(row, A, ledger).account_key, B);
  assert.deepEqual(planDraftOwnershipCorrections([run], doc, [run.run_id], ledger), ledger);
  assert.deepEqual(planDraftOwnershipCorrections([{ ...run, account_key: B, binding_account_status: 'matched' }],
    { [A]: { runs: [{ ...row, ownership: { account_key: B, method: 'verified_pool_and_match_identity' } }] } },
    [run.run_id], ledger), ledger);
  for (const changed of [
    { ...row, status: 'pending' }, { ...row, matches: [] },
    { ...row, matches: [{ id: 'match', account_key: C }] },
    { ...row, sources: [{ ...source, sha256: '3'.repeat(64) }] },
    { ...row, sources: [...row.sources, { run_id: '4'.repeat(32), sha256: source.sha256 }] },
  ]) assert.equal(draftOwnershipCorrection(changed, A, ledger), null);
  assert.equal(draftOwnershipCorrection(row, C, ledger), null);
  for (const changed of [
    { ...run, binding: 'unresolved' }, { ...run, binding_account_status: 'unknown' },
    { ...run, binding_account_key: C }, { ...run, matches: [] },
  ]) assert.throws(() => planDraftOwnershipCorrections([changed], doc, [run.run_id], empty));
  assert.throws(() => planDraftOwnershipCorrections([run], doc, [], empty));
  assert.throws(() => planDraftOwnershipCorrections([run], doc, [run.run_id, run.run_id], empty));
});

test('ledger is small, canonical, validated and cannot read symlink files or ancestors', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'draft-ownership-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  assert.deepEqual(await readDraftOwnershipCorrections(dataDir), empty);
  await mkdir(join(dataDir, 'draft-sync'));
  const ledger = planDraftOwnershipCorrections([run], doc, [run.run_id], empty), path = join(dataDir, draftOwnershipPath);
  await writeFile(path, linkText(ledger));
  assert.deepEqual(await readDraftOwnershipCorrections(dataDir), ledger);
  for (const changed of [
    { ...ledger, hidden: 'discarded' },
    { ...ledger, corrections: [...ledger.corrections, ...ledger.corrections] },
    { ...ledger, corrections: [{ ...ledger.corrections[0], account_key: 'bad' }] },
  ]) {
    await writeFile(path, linkText(changed));
    await assert.rejects(readDraftOwnershipCorrections(dataDir));
  }
  await rm(path);
  await writeFile(join(dataDir, 'outside.json'), linkText(ledger));
  await symlink(join(dataDir, 'outside.json'), path);
  await assert.rejects(readDraftOwnershipCorrections(dataDir));
  await rm(path); await rm(join(dataDir, 'draft-sync'), { recursive: true });
  await mkdir(join(dataDir, 'outside'));
  await writeFile(join(dataDir, 'outside/ownership-corrections.json'), linkText(ledger));
  await symlink(join(dataDir, 'outside'), join(dataDir, 'draft-sync'));
  await assert.rejects(readDraftOwnershipCorrections(dataDir));
});
