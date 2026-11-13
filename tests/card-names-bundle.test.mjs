import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  bundledCardNamesFingerprint,
  loadBundledChineseDisplayNames,
  loadDisplayNames,
  loadInstalledChineseDisplayNames,
} from '../src/display-names.mjs';

async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'mtga-card-names-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function database(path, name) {
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE Cards (GrpId INTEGER,TitleId INTEGER); CREATE TABLE Localizations_zhCN (LocId INTEGER,Formatted INTEGER,Loc TEXT);');
  db.prepare('INSERT INTO Cards VALUES (?,?)').run(6873, 1);
  db.prepare('INSERT INTO Localizations_zhCN VALUES (?,?,?)').run(1, 1, name);
  db.close();
}

test('bundled names work without an installed Chinese client', async (t) => {
  const home = await temporary(t);
  const names = await loadDisplayNames({ home });
  assert.equal(names.size, 27236);
  assert.equal(names.get(6873), '猛进犀群');
  assert.equal(names.get(106931), '月主教米凯耶');
  assert.equal(names.has(107793), false);
});

test('installed game localization overrides bundled ids', async (t) => {
  const root = await temporary(t), path = join(root, 'Raw_CardDatabase_synthetic.mtga');
  await database(path, '测试译名');
  const names = await loadDisplayNames({ displayNameDb: path });
  assert.equal(names.get(6873), '测试译名');
  assert.equal(names.get(106931), '月主教米凯耶');
  assert.equal((await loadInstalledChineseDisplayNames({ displayNameDb: path })).get(6873), '测试译名');
});

test('bundled loader and fingerprint are stable', async () => {
  const first = await loadBundledChineseDisplayNames();
  const second = await loadBundledChineseDisplayNames();
  assert.equal(first, second);
  assert.equal(first.size, 27236);
  const fingerprint = await bundledCardNamesFingerprint();
  assert.match(fingerprint, /^2026\.64\.50-r5:[a-f0-9]{64}$/);
  assert.equal(fingerprint, await bundledCardNamesFingerprint());
});
