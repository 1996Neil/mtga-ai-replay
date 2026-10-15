import { DatabaseSync } from 'node:sqlite';
import { mkdir, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultDataDir } from '../history.mjs';

const validId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,120}$/.test(value);
const validGame = value => Number.isSafeInteger(value) && value > 0;

async function open(dataDir, write) {
  const path = join(dataDir, 'reviews.sqlite3');
  if (write) await mkdir(dataDir, { recursive: true, mode: 0o700 });
  else {
    try { await stat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  const database = new DatabaseSync(path, { readOnly: !write });
  try {
    if (write) {
      database.exec(`CREATE TABLE IF NOT EXISTS replay_reviews (
        match_id TEXT NOT NULL,
        game_number INTEGER NOT NULL,
        review_json TEXT NOT NULL,
        PRIMARY KEY(match_id, game_number)
      )`);
      await chmod(path, 0o600);
    }
    return database;
  } catch (error) { database.close(); throw error; }
}

export async function readReplayReview(matchId, gameNumber, { dataDir = defaultDataDir() } = {}) {
  if (!validId(matchId) || !validGame(gameNumber)) return null;
  const database = await open(dataDir, false);
  if (!database) return null;
  try {
    // Old local archive may predate the table; this is an optional sidecar.
    const row = database.prepare('SELECT review_json FROM replay_reviews WHERE match_id = ? AND game_number = ?')
      .get(matchId, gameNumber);
    return row ? JSON.parse(row.review_json) : null;
  } finally { database.close(); }
}

export async function writeReplayReview(review, { dataDir = defaultDataDir() } = {}) {
  if (!validId(review?.match_id) || !validGame(review?.game_number) ||
    review.schema_version !== 'replay-review/1.0') throw new Error('Invalid review identity or schema.');
  const database = await open(dataDir, true);
  try {
    database.prepare(`INSERT INTO replay_reviews (match_id, game_number, review_json) VALUES (?, ?, ?)
      ON CONFLICT(match_id, game_number) DO UPDATE SET review_json = excluded.review_json`)
      .run(review.match_id, review.game_number, JSON.stringify(review));
  } finally { database.close(); }
}
