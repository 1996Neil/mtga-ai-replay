import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverDisplayNameDatabase, loadChineseDisplayNames } from '../src/display-names.mjs';
import { loadCardNames } from '../src/cards.mjs';
import { archiveReplays } from '../src/history.mjs';
import { startReplayServer } from '../src/server.mjs';

async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'mtga-display-names-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function database(path, { nativeChinese = false, english = false } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE Cards (GrpId INTEGER,TitleId INTEGER); CREATE TABLE Localizations_enUS (LocId INTEGER,Formatted INTEGER,Loc TEXT);');
  const names = english ? ['Forest', 'Mountain', 'Island', 'Plains', 'Swamp', 'Interjection'] : ['树林', '山脉', '海岛', '平原', '沼泽', '感叹作结'];
  const card = db.prepare('INSERT INTO Cards VALUES (?,?)'), loc = db.prepare('INSERT INTO Localizations_enUS VALUES (?,1,?)');
  names.forEach((name, index) => { card.run(index + 100, index + 1000); loc.run(index + 1000, name); });
  if (nativeChinese) {
    db.exec('CREATE TABLE Localizations_zhCN (LocId INTEGER,Formatted INTEGER,Loc TEXT);');
    db.exec("INSERT INTO Localizations_zhCN VALUES (1000,1,'<b>树林</b>'),(1005,0,'感叹作结'),(1005,1,'备用译名'),(1001,0,'English untranslated title');");
  }
  db.close();
}

test('native Chinese display names resolve by Arena ID without changing English canonical names or database bytes', async (t) => {
  const root = await temporary(t), path = join(root, 'native.mtga');
  await database(path, { nativeChinese: true, english: true });
  const original = await readFile(path);
  const english = await loadCardNames(path), chinese = await loadChineseDisplayNames(path);
  assert.equal(english.get(100), 'Forest');
  assert.equal(english.get(105), 'Interjection');
  assert.equal(chinese.get(100), '树林');
  assert.equal(chinese.get(105), '感叹作结');
  assert.equal(chinese.has(101), false);
  assert.deepEqual(await readFile(path), original);
});

test('installed patched enUS is recognized from five Chinese basic lands and backup discovery is excluded', async (t) => {
  const home = await temporary(t);
  const path = join(home, 'Library', 'Application Support', 'Steam', 'steamapps', 'common', 'MTGA', 'MTGA_Data', 'Downloads', 'Raw', 'Raw_CardDatabase_synthetic.mtga');
  await database(path);
  const backup = join(home, 'Documents', 'Codex', 'MTGA-backups', 'synthetic', 'originals', 'MTGA_Data', 'Downloads', 'Raw', 'Raw_CardDatabase_synthetic.mtga');
  await database(backup, { english: true });
  const selected = await discoverDisplayNameDatabase({ home });
  assert.equal(selected, await realpath(path));
  assert.equal((await loadChineseDisplayNames(selected)).get(105), '感叹作结');
  assert.deepEqual(await loadChineseDisplayNames(backup), new Map());
});

test('missing or unmodified English localization gracefully leaves display-name bridge empty', async (t) => {
  const root = await temporary(t), english = join(root, 'english.mtga');
  await database(english, { english: true });
  assert.deepEqual(await loadChineseDisplayNames(null), new Map());
  assert.deepEqual(await loadChineseDisplayNames(join(root, 'missing.mtga')), new Map());
  assert.equal(await discoverDisplayNameDatabase({ displayNameDb: english }), null);
});

test('card API adds Chinese display field separately while cached metadata, replay and Coach Context stay English', async (t) => {
  const root = await temporary(t), dataDir = join(root, 'data');
  const card = { name: 'Interjection', arena_id: 105, instance_id: 205, visibility: 'player_known' };
  const state = { turn: 12, players: { me: { hand: [card], handSize: 1 }, opponent: { hand: [], handSize: 2 } }, stack: [] };
  const replay = { schema_version: '2.0', match: { id: 'synthetic-display', started_at: '2026-10-02T00:00:00Z' },
    games: [{ game_number: 1, states: { S1: state }, steps: [{ anchor: 'T12-A1', state_id: 'S1', event: { type: 'cast', actor: 'me', card } }] }] };
  await archiveReplays([replay], { dataDir });
  const running = await startReplayServer({ dataDir, viewerDir: root, writeInfo: false,
    displayNamesZh: new Map([[105, '感叹作结']]), fetchFn: async () => { throw new Error('Synthetic offline'); } });
  t.after(() => running.close());
  const metadata = await fetch(running.url + 'api/cards/105').then(response => response.json());
  assert.equal(metadata.name, 'Interjection');
  assert.equal(metadata.display_name_zh, '感叹作结');
  const stored = await fetch(running.url + 'api/matches/synthetic-display').then(response => response.json());
  const context = await fetch(running.url + 'api/matches/synthetic-display/context?game=1&anchor=T12-A1&boundary=after').then(response => response.json());
  assert.equal(stored.games[0].states.S1.players.me.hand[0].name, 'Interjection');
  assert.equal(context.state.players.me.hand[0].name, 'Interjection');
  assert.doesNotMatch(JSON.stringify({ stored, context }), /感叹作结|display_name_zh/);
  const cache = JSON.parse(await readFile(join(dataDir, 'cards', '105.json'), 'utf8'));
  assert.equal(cache.name, 'Interjection');
  assert.equal('display_name_zh' in cache, false);
});
