import { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { mkdir, stat, chmod, open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import { discoverLogs } from './discovery.mjs';
import { createRecordFramer } from './log-reader.mjs';
import { discoverCardDatabase, loadCardNames, loadCounterNames } from './cards.mjs';
import { buildReplays } from './replay.mjs';
import { archiveReplays, listReplays, defaultDataDir, isReplayExcluded } from './history.mjs';
import { readReplaySettings, replayInRetention } from './replay-settings.mjs';
import { atomicSyncWrite } from './coach-sync.mjs';

async function windowHash(path, offset, size) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(size), { bytesRead } = await handle.read(buffer, 0, size, offset);
    return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
  } finally { await handle.close(); }
}
async function labels(dataDir, source) {
  if (!source) return { names: new Map(), counterNames: new Map() };
  const info = await stat(source, { bigint: true });
  const identity = [source, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String);
  const path = join(dataDir, 'replay-card-labels.json');
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (JSON.stringify(value.identity) === JSON.stringify(identity))
      return { names: new Map(value.names), counterNames: new Map(value.counterNames) };
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const names = await loadCardNames(source), counterNames = await loadCounterNames(source);
  await atomicSyncWrite(path, JSON.stringify({ identity, names: [...names], counterNames: [...counterNames] }));
  return { names, counterNames };
}

/** A persisted file cursor plus match-indexed records. Never scan archive blobs. */
export async function importIncrementalReplays({ dataDir = defaultDataDir(), logPath, logDir, cardDb } = {}) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'replay-ingest.sqlite3'), database = new DatabaseSync(path);
  await chmod(path, 0o600);
  database.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, identity TEXT NOT NULL, size INTEGER NOT NULL,
      mtime TEXT NOT NULL, checkpoint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records(sequence INTEGER PRIMARY KEY, hash TEXT UNIQUE NOT NULL,
      match_id TEXT, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS records_match ON records(match_id);
    CREATE TABLE IF NOT EXISTS dirty(match_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS matches(match_id TEXT PRIMARY KEY, started_at TEXT);`);
  const policy = await readReplaySettings(dataDir);
  const catalog = new Map((await listReplays({ dataDir, limit: null })).map(match => [match.id, match]));
  let bytesRead = 0, filesRead = 0, inheritedMatch = null, archived = 0, conflicts = 0;
  try {
    for (const file of await discoverLogs({ logPath, logDir })) {
      const info = await stat(file, { bigint: true }), identity = `${info.dev}:${info.ino}`;
      const old = database.prepare('SELECT * FROM files WHERE path=?').get(file);
      if (old?.identity === identity && BigInt(old.size) === info.size && old.mtime === String(info.mtimeNs)) {
        inheritedMatch = JSON.parse(old.checkpoint).current;
        continue;
      }
      const saved = old ? JSON.parse(old.checkpoint) : null;
      const tailStart = old ? Math.max(0, old.size - 256) : 0;
      const append = old?.identity === identity && BigInt(old.size) < info.size && saved.tail &&
        saved.tail === await windowHash(file, tailStart, old.size - tailStart) &&
        saved.head === await windowHash(file, 0, Math.min(old.size, 256));
      const prior = append ? saved : null;
      let current = prior?.current ?? inheritedMatch;
      const decoder = new StringDecoder('utf8');
      if (prior?.decoder) {
        const pending = prior.decoder.lastTotal - prior.decoder.lastNeed;
        if (prior.decoder.lastNeed) decoder.write(Buffer.from(prior.decoder.lastChar, 'base64').subarray(0, pending));
      }
      const framer = createRecordFramer({ snapshot: prior?.framer });
      const insert = database.prepare('INSERT OR IGNORE INTO records(hash,match_id,json) VALUES(?,?,?)');
      const dirty = database.prepare('INSERT OR IGNORE INTO dirty VALUES(?)');
      database.exec('BEGIN IMMEDIATE');
      try {
        // Bound reads to the observed size. Appended bytes belong to the next poll.
        if (info.size > 0n) for await (const chunk of createReadStream(file, { start: append ? old.size : 0, end: Number(info.size) - 1 })) {
          bytesRead += chunk.length;
          for (const event of framer.feedEvents(decoder.write(chunk))) {
            if (event.type === 'integrity_loss') { current = null; continue; }
            const record = event.record, room = record.matchGameRoomStateChangedEvent?.gameRoomInfo;
            current = room?.gameRoomConfig?.matchId ?? room?.finalMatchResult?.matchId ?? current;
            const messages = record.greToClientEvent?.greToClientMessages ?? [];
            const explicit = [...new Set(messages.map(message => message.gameStateMessage?.gameInfo?.matchID ??
              message.gameStateMessage?.gameInfo?.matchId).filter(id => typeof id === 'string'))];
            if (explicit.length === 1) current = explicit[0];
            const roomId = room?.gameRoomConfig?.matchId;
            const timestamp = /^\d{10,}$/.test(record.timestamp) ? Number(record.timestamp) : record.timestamp;
            if (roomId && Number.isFinite(new Date(timestamp).getTime()))
              database.prepare('INSERT OR IGNORE INTO matches VALUES(?,?)').run(roomId, new Date(timestamp).toISOString());
            const groups = new Map();
            if (messages.length) {
              for (const message of messages) {
                const bound = message.gameStateMessage?.gameInfo?.matchID ?? message.gameStateMessage?.gameInfo?.matchId;
                // Only pure connection responses may be global context. A
                // game-state frame must never enter another match's builder.
                const id = !message.gameStateMessage && message.type === 'GREMessageType_ConnectResp' ? null : bound ?? current;
                if (!groups.has(id)) groups.set(id, []);
                groups.get(id).push(message);
              }
            } else groups.set(room ? current : null, null);
            for (const [matchId, group] of groups) {
              const value = group ? { ...record, greToClientEvent: { ...record.greToClientEvent, greToClientMessages: group } } : record;
              const json = JSON.stringify(value), hash = createHash('sha256').update(json).digest('hex');
              const inserted = insert.run(hash, matchId, json).changes;
              if (inserted && matchId) dirty.run(matchId);
            }
          }
        }
        const checkpoint = JSON.stringify({ current,
          head: await windowHash(file, 0, Math.min(Number(info.size), 256)),
          tail: await windowHash(file, Math.max(0, Number(info.size) - 256), Math.min(Number(info.size), 256)),
          framer: framer.snapshot(), decoder: {
          lastNeed: decoder.lastNeed, lastTotal: decoder.lastTotal, lastChar: decoder.lastChar.toString('base64') } });
        database.prepare(`INSERT INTO files VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET
          identity=excluded.identity,size=excluded.size,mtime=excluded.mtime,checkpoint=excluded.checkpoint`)
          .run(file, identity, Number(info.size), String(info.mtimeNs), checkpoint);
        database.exec('COMMIT');
      } catch (error) { database.exec('ROLLBACK'); throw error; }
      inheritedMatch = current; filesRead++;
    }
    for (const row of database.prepare('SELECT * FROM matches').all()) if (!replayInRetention(row, policy)) {
      database.prepare('DELETE FROM dirty WHERE match_id=?').run(row.match_id);
      database.prepare('DELETE FROM records WHERE match_id=?').run(row.match_id);
    }
    const targets = database.prepare('SELECT match_id FROM dirty').all();
    if (!targets.length) return { cached: !filesRead, bytes_read: bytesRead, files_read: filesRead, archive: { archived: 0 } };
    const source = cardDb ?? await discoverCardDatabase();
    const { names, counterNames } = await labels(dataDir, source);
    for (const { match_id: id } of targets) {
      if (await isReplayExcluded(id, { dataDir }) || catalog.has(id) && !replayInRetention(catalog.get(id), policy)) {
        database.prepare('DELETE FROM dirty WHERE match_id=?').run(id);
        database.prepare('DELETE FROM records WHERE match_id=?').run(id);
        continue;
      }
      const records = database.prepare('SELECT json FROM records WHERE match_id=? OR match_id IS NULL ORDER BY sequence').all(id)
        .map(row => JSON.parse(row.json));
      const { replays } = await buildReplays(records, names, { counterNames });
      for (const replay of replays) if (replay.match.id === id && !replayInRetention(replay.match, policy)) {
        database.prepare('INSERT OR REPLACE INTO matches VALUES(?,?)').run(id, replay.match.started_at);
        database.prepare('DELETE FROM records WHERE match_id=?').run(id);
      }
      const result = await archiveReplays(replays.filter(replay => replay.match.id === id), { dataDir });
      archived += result.archived; conflicts += result.conflicts ?? 0;
      database.prepare('DELETE FROM dirty WHERE match_id=?').run(id);
    }
    return { cached: false, bytes_read: bytesRead, files_read: filesRead, archive: { archived, conflicts } };
  } finally { database.close(); }
}
