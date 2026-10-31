#!/usr/bin/env python3
"""Read-only 17Lands log adapter. No HTTP, credentials, model or Git access."""
import argparse
import ast
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import uuid

ACCOUNT = re.compile(r'^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9]{26})$', re.IGNORECASE)
VERSION = '17lands-log-v2'
MAX_LINE = 1024 * 1024
PREFIX = re.compile(r'^(\d{8} \d{6}\.\d{3}),INFO,[^,]+,Draft (pack|pick): (.*)$')
EVENT = re.compile(r'[A-Za-z][A-Za-z0-9_-]{1,120}\Z')


def digest(value):
    return hashlib.sha256(value).hexdigest()


def normalize(line):
    match = PREFIX.match(line)
    if not match:
        return None
    stamp, kind, literal = match.groups()
    value = ast.literal_eval(literal)
    if not isinstance(value, dict):
        raise ValueError('unsupported event')
    event = value.get('event_name') or value.get('EventId') or ('HumanDraft_' + str(value.get('draftId') or value.get('DraftId', 'unknown')))
    pack = value.get('pack_number', value.get('PackNumber', value.get('SelfPack', value.get('Pack'))))
    pick = value.get('pick_number', value.get('PickNumber', value.get('SelfPick', value.get('Pick'))))
    if not EVENT.fullmatch(str(event)):
        raise ValueError('unsupported event')
    if type(pack) is not int or type(pick) is not int or not 0 <= pack <= 2 or not 0 <= pick < 30:
        raise ValueError('invalid draft coordinate')
    cards = value.get('card_ids')
    if cards is None and kind == 'pack':
        cards = value.get('CardsInPack', value.get('PackCards'))
        if isinstance(cards, str): cards = [int(x) for x in cards.split(',') if x.strip()]
    if kind == 'pick' and cards is None:
        cards = value.get('card_ids', value.get('GrpIds')) or [value.get('card_id', value.get('PickGrpId'))]
    if not isinstance(cards, list) or not 1 <= len(cards) <= 100 or any(type(c) is not int or not 0 < c < 2147483648 for c in cards):
        raise ValueError('invalid card IDs')
    # This is the tracker log's LOCAL receipt time, not Arena's action timestamp.
    logged_at = dt.datetime.strptime(stamp, '%Y%m%d %H%M%S.%f').astimezone().isoformat(timespec='milliseconds')
    return dict(adapter=VERSION, kind=kind, event_id=str(event), pack_number=pack + 1,
                pick_number=pick + 1, card_ids=cards, logged_at=logged_at)


def connect(data_dir):
    root = Path(data_dir)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = root / 'draft-capture.sqlite3'
    if path.is_symlink():
        raise ValueError('database must not be a symlink')
    # Restrict from creation, before SQLite writes any user data.
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    os.close(fd)
    os.chmod(path, 0o600)
    db = sqlite3.connect(path, timeout=10)
    db.execute('PRAGMA journal_mode=DELETE')
    db.execute('PRAGMA synchronous=FULL')
    db.executescript('''
      CREATE TABLE IF NOT EXISTS sources (
        file_key TEXT PRIMARY KEY, incarnation TEXT NOT NULL, byte_offset INTEGER NOT NULL,
        checkpoint TEXT NOT NULL, account_key TEXT, disconnected TEXT);
      CREATE TABLE IF NOT EXISTS accounts (account_key TEXT PRIMARY KEY, label TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS observations (
        seq INTEGER PRIMARY KEY, observation_id TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gaps (
        gap_id TEXT PRIMARY KEY, reason TEXT NOT NULL);
    ''')
    db.execute("INSERT OR IGNORE INTO meta VALUES ('observation_revision','0')")
    db.executescript('''
      CREATE TRIGGER IF NOT EXISTS draft_observations_insert AFTER INSERT ON observations
      BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='observation_revision'; END;
      CREATE TRIGGER IF NOT EXISTS draft_observations_update AFTER UPDATE ON observations
      BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='observation_revision'; END;
      CREATE TRIGGER IF NOT EXISTS draft_observations_delete AFTER DELETE ON observations
      BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='observation_revision'; END;
    ''')
    return db


def capture(log_dir, data_dir, before_commit=None, start_now=False):
    """Observation insertion and complete-line cursor advancement share one transaction."""
    db = connect(data_dir)
    added = 0
    try:
        db.execute('BEGIN IMMEDIATE')
        bootstrap = start_now and db.execute("SELECT value FROM meta WHERE key='initialized'").fetchone() is None
        row = db.execute("SELECT value FROM meta WHERE key='active_account'").fetchone()
        active = row[0] if row else None
        row = db.execute("SELECT value FROM meta WHERE key='disconnected'").fetchone()
        disconnected = row[0] if row else None
        # Rotation renames an inode; that identity deliberately excludes the filename.
        files = sorted(Path(log_dir).glob('seventeenlands.log*'), key=lambda p: (p.stat().st_mtime_ns, p.name))
        for path in files:
            if path.is_symlink() or not path.is_file():
                continue
            with path.open('rb') as source:
                info = os.fstat(source.fileno())
                key = str(info.st_dev) + ':' + str(info.st_ino)
                prior = db.execute('SELECT incarnation,byte_offset,checkpoint,account_key,disconnected FROM sources WHERE file_key=?', (key,)).fetchone()
                incarnation, offset, checkpoint, account, departed = prior or (uuid.uuid4().hex, 0, digest(b''), active, disconnected)
                source.seek(max(0, offset - 256))
                actual = digest(source.read(min(256, offset)))
                if info.st_size < offset or actual != checkpoint:
                    db.execute('INSERT OR IGNORE INTO gaps VALUES (?,?)', (digest((incarnation + str(offset)).encode()), 'source_replaced_or_truncated'))
                    incarnation, offset, account, departed = uuid.uuid4().hex, 0, None, None
                source.seek(offset)
                while True:
                    start = source.tell()
                    if bootstrap and start >= info.st_size:
                        break
                    raw = source.readline(min(MAX_LINE + 1, info.st_size - start) if bootstrap else MAX_LINE + 1)
                    if not raw:
                        break
                    if len(raw) > MAX_LINE:
                        # Keep the cursor at the start until an entire oversized line exists.
                        while raw and not raw.endswith(b'\n'):
                            raw = source.readline(MAX_LINE + 1)
                        if not raw.endswith(b'\n'):
                            source.seek(start)
                            break
                        db.execute('INSERT OR IGNORE INTO gaps VALUES (?,?)', (digest((incarnation + str(start)).encode()), 'line_limit_exceeded'))
                        account, departed = None, None
                        continue
                    if not raw.endswith(b'\n'):
                        source.seek(start)
                        break
                    parts = raw.split(b',', 3)
                    message = parts[3] if len(parts) == 4 and parts[1] == b'INFO' else b''
                    message = re.sub(b'Human draft [^:]*pack[^:]*: ', b'Draft pack: ', message)
                    message = re.sub(b'Human draft [^:]*pick[^:]*: ', b'Draft pick: ', message)
                    # Identity can arrive only when the first match starts, after a
                    # whole draft. A new Arena log must not inherit the old login.
                    if message.startswith(b'Starting from beginning of file'):
                        account, departed = None, None
                        continue
                    if message.startswith(b'Updating user info: '):
                        try:
                            info_value = ast.literal_eval(message.decode('utf-8')[len('Updating user info: '):].strip())
                            player_id = info_value.get('player_id')
                            if not isinstance(player_id, str) or not ACCOUNT.fullmatch(player_id):
                                raise ValueError('unknown account')
                            account = digest(('MTGA_ACCOUNT_V1\0' + player_id.lower()).encode())
                            label = info_value.get('screen_name')
                            label = ''.join(ch for ch in label if ch.isprintable())[:80] if isinstance(label, str) else ''
                            label = label or ('账号 ' + account[:8])
                            db.execute('INSERT INTO accounts VALUES (?,?) ON CONFLICT(account_key) DO UPDATE SET label=excluded.label', (account, label))
                            departed = None
                        except (ValueError, SyntaxError, TypeError, AttributeError, UnicodeError, RecursionError):
                            account, departed = None, None
                        continue
                    if message.startswith(b'User logged out from MTGA'):
                        departed, account = account, None
                        continue
                    if message.startswith(b'Reconnected - restoring prior user info'):
                        account, departed = departed, None
                        continue
                    if message.startswith(b'Saving logs to '):
                        account, departed = None, None
                        continue
                    if bootstrap:
                        continue
                    if b',Draft pack: ' not in raw and b',Draft pick: ' not in raw and b',Human draft ' not in raw:
                        continue
                    raw = re.sub(b'Human draft [^:]*pack[^:]*: ', b'Draft pack: ', raw)
                    raw = re.sub(b'Human draft [^:]*pick[^:]*: ', b'Draft pick: ', raw)
                    identity = digest((incarnation + ':' + str(start) + ':' + digest(raw)).encode())
                    try:
                        normalized = normalize(raw.decode('utf-8').rstrip('\r\n'))
                        if normalized is None:
                            raise ValueError('unsupported log prefix')
                    except (ValueError, SyntaxError, TypeError, UnicodeError, RecursionError):
                        db.execute('INSERT OR IGNORE INTO gaps VALUES (?,?)', (identity, 'unsupported_or_malformed_draft'))
                        continue
                    normalized['account_key'] = account
                    body = json.dumps(normalized, separators=(',', ':'), ensure_ascii=True)
                    added += db.execute('INSERT OR IGNORE INTO observations(observation_id,body) VALUES (?,?)', (identity, body)).rowcount
                offset = source.tell()
                source.seek(max(0, offset - 256))
                checkpoint = digest(source.read(min(256, offset)))
                db.execute('INSERT INTO sources VALUES (?,?,?,?,?,?) ON CONFLICT(file_key) DO UPDATE SET incarnation=excluded.incarnation,byte_offset=excluded.byte_offset,checkpoint=excluded.checkpoint,account_key=excluded.account_key,disconnected=excluded.disconnected WHERE sources.incarnation IS NOT excluded.incarnation OR sources.byte_offset IS NOT excluded.byte_offset OR sources.checkpoint IS NOT excluded.checkpoint OR sources.account_key IS NOT excluded.account_key OR sources.disconnected IS NOT excluded.disconnected', (key, incarnation, offset, checkpoint, account, departed))
                active, disconnected = account, departed
        db.execute("INSERT INTO meta VALUES ('initialized','1') ON CONFLICT(key) DO NOTHING")
        db.execute("INSERT INTO meta VALUES ('active_account',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE meta.value IS NOT excluded.value", (account if files else active,))
        db.execute("INSERT INTO meta VALUES ('disconnected',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE meta.value IS NOT excluded.value", (departed if files else disconnected,))
        if before_commit:
            before_commit()
        db.commit()
        return dict(added=added, observations=db.execute('SELECT COUNT(*) FROM observations').fetchone()[0],
                    gaps=db.execute('SELECT COUNT(*) FROM gaps').fetchone()[0])
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--log-dir', default=str(Path.home() / '.seventeenlands'))
    parser.add_argument('--data-dir', default=str(Path.home() / '.local/share/mtga-gpt-replay'))
    parser.add_argument('--from-start', action='store_true', help='Explicit offline/test import; default skips historical picks on first run')
    args = parser.parse_args()
    try:
        print(json.dumps(capture(args.log_dir, args.data_dir, start_now=not args.from_start)))
    except Exception:
        # Never echo literals, source paths, account data or exception payloads.
        parser.exit(1, 'Draft capture failed; retained committed observations and cursor.\n')
