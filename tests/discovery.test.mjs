import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes, symlink, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { discoverLogs } from '../src/discovery.mjs';
import { discoverCardDatabase, loadCardNames } from '../src/cards.mjs';

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'mtga-discovery-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

async function log(path, contents, mtime) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents);
  if (mtime) await utimes(path, mtime, mtime);
  return path;
}

test('Mac Player/current/previous and Steam UTC logs are discovered chronologically', async (t) => {
  const home = await fixture(t);
  const playerDir = join(home, 'Library', 'Logs', 'Wizards Of The Coast', 'MTGA');
  const utcDir = join(home, 'Library', 'Application Support', 'Steam', 'steamapps', 'common', 'MTGA', 'MTGA_Data', 'Logs', 'Logs');
  const old = await log(join(playerDir, 'Player-prev.log'), 'previous', new Date('2026-10-01T00:00:00Z'));
  const utc = await log(join(utcDir, 'UTC_Log - 10-02-2026 00.00.00.log'), 'utc', new Date('2026-10-02T00:00:00Z'));
  const current = await log(join(playerDir, 'Player.log'), 'current', new Date('2026-10-02T01:00:00Z'));
  await log(join(playerDir, 'unrelated.log'), 'ignore');
  const before = await stat(current);
  assert.deepEqual(await discoverLogs({ home }), [old, utc, current]);
  assert.equal((await stat(current)).mtimeMs, before.mtimeMs);
});

test('non-Steam UTC logs and configured external Steam library are discovered', async (t) => {
  const home = await fixture(t);
  const standalone = await log(join(home, 'Library', 'Application Support', 'com.wizards.mtga', 'Logs', 'Logs', 'UTC_Log - 10-01-2026 00.00.00.log'), 'native', new Date('2026-10-01T00:00:00Z'));
  const library = join(home, 'External Steam');
  await log(join(home, 'Library', 'Application Support', 'Steam', 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "1" { "path" "${library}" } }`);
  const external = await log(join(library, 'steamapps', 'common', 'MTGA', 'MTGA_Data', 'Logs', 'Logs', 'UTC_Log - 10-02-2026 00.00.00.log'), 'steam', new Date('2026-10-02T00:00:00Z'));
  assert.deepEqual(await discoverLogs({ home }), [standalone, external]);
});

test('explicit file/directory selection validates paths and removes symlink duplicates', async (t) => {
  const home = await fixture(t);
  const original = await log(join(home, 'selected', 'Player.log'), 'test');
  await symlink(original, join(home, 'selected', 'Player-prev.log'));
  assert.deepEqual(await discoverLogs({ logPath: original }), [original]);
  assert.deepEqual(await discoverLogs({ logDir: join(home, 'selected') }), [original]);
  await assert.rejects(discoverLogs({ logPath: join(home, 'missing') }), /Cannot read log file/);
  await assert.rejects(discoverLogs({ logDir: join(home, 'missing') }), /Cannot read log directory/);
  await assert.rejects(discoverLogs({ logPath: original, logDir: home }), /either --log or --log-dir/);
});

test('missing automatic Mac directories return no logs or card database', async (t) => {
  const home = await fixture(t);
  assert.deepEqual(await discoverLogs({ home }), []);
  assert.equal(await discoverCardDatabase({ home }), null);
  assert.deepEqual(await loadCardNames(null), new Map());
  assert.deepEqual(await loadCardNames(join(home, 'missing.mtga')), new Map());
});

test('installed SQLite resolves English unformatted names and remains unchanged', async (t) => {
  const home = await fixture(t);
  const raw = join(home, 'Library', 'Application Support', 'com.wizards.mtga', 'Downloads', 'Raw');
  await mkdir(raw, { recursive: true });
  const path = join(raw, 'Raw_CardDatabase_test.mtga');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE Cards (GrpId INTEGER, TitleId INTEGER);
    CREATE TABLE Localizations_enUS (LocId INTEGER, Formatted INTEGER, Loc TEXT);
    INSERT INTO Cards VALUES (1, 101), (2, 102), (3, 103);
    INSERT INTO Localizations_enUS VALUES (101, 0, 'Mountain'), (101, 1, '<b>Mountain</b>'), (102, 0, 'Lightning Bolt'), (103, 1, '<b>Fire &amp; Ice</b>');`);
  db.close();
  const before = await stat(path);
  assert.equal(await discoverCardDatabase({ home }), path);
  assert.equal(await discoverCardDatabase({ cardDb: path }), path);
  assert.deepEqual(await loadCardNames(path), new Map([[1, 'Mountain'], [2, 'Lightning Bolt'], [3, 'Fire & Ice']]));
  const after = await stat(path);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.size, before.size);
});

test('matching original English backup is preferred to a translated installed database', async (t) => {
  const home = await fixture(t);
  const raw = join(home, 'Library', 'Application Support', 'com.wizards.mtga', 'Downloads', 'Raw');
  const backupRaw = join(home, 'Documents', 'Codex', 'MTGA-backups', 'dated-backup', 'originals', 'MTGA_Data', 'Downloads', 'Raw');
  await mkdir(raw, { recursive: true });
  await mkdir(backupRaw, { recursive: true });
  const filename = 'Raw_CardDatabase_same.mtga';
  for (const [directory, titles] of [
    [raw, ['树林', '山脉', '海岛', '平原', '沼泽']],
    [backupRaw, ['Forest', 'Mountain', 'Island', 'Plains', 'Swamp']],
  ]) {
    const database = new DatabaseSync(join(directory, filename));
    database.exec('CREATE TABLE Cards (GrpId INTEGER, TitleId INTEGER); CREATE TABLE Localizations_enUS (LocId INTEGER, Formatted INTEGER, Loc TEXT);');
    const card = database.prepare('INSERT INTO Cards VALUES (?, ?)');
    const localization = database.prepare('INSERT INTO Localizations_enUS VALUES (?, 1, ?)');
    titles.forEach((title, index) => { card.run(index + 1, index + 100); localization.run(index + 100, title); });
    database.close();
  }
  assert.equal(await discoverCardDatabase({ home }), join(backupRaw, filename));
  assert.equal(await discoverCardDatabase({ cardDb: join(raw, filename) }), join(raw, filename));
});

test('English F0 titles remain discoverable while mixed translated variants use the matching original', async (t) => {
  const home = await fixture(t);
  const raw = join(home, 'Library', 'Application Support', 'com.wizards.mtga', 'Downloads', 'Raw');
  const backupRaw = join(home, 'Documents', 'Codex', 'MTGA-backups', 'dated-backup', 'originals', 'MTGA_Data', 'Downloads', 'Raw');
  await mkdir(raw, { recursive: true });
  await mkdir(backupRaw, { recursive: true });
  const filename = 'Raw_CardDatabase_name_variants.mtga';
  const installed = join(raw, filename), original = join(backupRaw, filename);
  const titles = [
    [75553, 647, 'Forest', '树林'], [75555, 1250, 'Mountain', '山脉'],
    [75554, 652, 'Island', '海岛'], [75556, 648, 'Plains', '平原'],
    [75557, 653, 'Swamp', '沼泽'],
    [86835, 731610, 'Hearth Elemental', '壁炉元素'],
    [86836, 731612, 'Stoke Genius', '炉光一笔'],
  ];
  for (const [path, formatted] of [[installed, 0], [original, 1]]) {
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE Cards (GrpId INTEGER PRIMARY KEY, TitleId INTEGER);
      CREATE TABLE Localizations_enUS (LocId INTEGER, Formatted INTEGER, Loc TEXT, PRIMARY KEY (LocId, Formatted));`);
    const card = database.prepare('INSERT INTO Cards VALUES (?, ?)');
    const localization = database.prepare('INSERT INTO Localizations_enUS VALUES (?, ?, ?)');
    for (const [grpId, titleId, english] of titles) {
      card.run(grpId, titleId); localization.run(titleId, formatted, english);
    }
    database.close();
  }
  // A genuinely English resource with F0-only titles still wins over its backup.
  assert.equal(await discoverCardDatabase({ home }), installed);
  assert.equal((await loadCardNames(installed)).get(86836), 'Stoke Genius');

  const mixed = new DatabaseSync(installed);
  const translated = mixed.prepare('INSERT INTO Localizations_enUS VALUES (?, 1, ?)');
  for (const [, titleId, , chinese] of titles) translated.run(titleId, chinese);
  // The patch adds an English front name but leaves this non-primary face Chinese.
  mixed.prepare('DELETE FROM Localizations_enUS WHERE LocId=? AND Formatted=0').run(731612);
  mixed.close();
  const automatic = await discoverCardDatabase({ home });
  assert.equal(automatic, original);
  assert.equal((await loadCardNames(automatic)).get(86835), 'Hearth Elemental');
  assert.equal((await loadCardNames(automatic)).get(86836), 'Stoke Genius');
  const explicit = await discoverCardDatabase({ home, cardDb: installed });
  assert.equal(explicit, installed);
  assert.equal((await loadCardNames(explicit)).get(86835), 'Hearth Elemental');
  assert.equal((await loadCardNames(explicit)).get(86836), undefined); // No English variant: retain Arena ID fallback.
});

test('patched enUS card and counter labels cannot become Chinese machine identities', async t => {
  const { loadCounterNames } = await import('../src/cards.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'mtga-mixed-names-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'mixed.mtga'), db = new DatabaseSync(path);
  db.exec(`CREATE TABLE Cards(GrpId INTEGER,TitleId INTEGER); CREATE TABLE Localizations_enUS(LocId INTEGER,Formatted INTEGER,Loc TEXT);
    CREATE TABLE Enums(Type TEXT,Value INTEGER,LocId INTEGER);
    INSERT INTO Cards VALUES(1,1),(2,2),(3,3);
    INSERT INTO Localizations_enUS VALUES(1,0,'Forest'),(2,0,'中文机器名'),(2,1,'English Variant'),(3,0,'仅中文'),(7,0,'忠诚'),(8,0,'Loyalty');
    INSERT INTO Enums VALUES('CounterType',7,7),('CounterType',8,8);`); db.close();
  assert.deepEqual(await loadCardNames(path), new Map([[1,'Forest'],[2,'English Variant']]));
  assert.deepEqual(await loadCounterNames(path), new Map([[8,'Loyalty']]));
});
