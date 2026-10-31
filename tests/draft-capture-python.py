import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('capture', Path(__file__).resolve().parents[1] / 'tools/draft-capture/capture.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def line(kind='pack', cards=None, **extra):
    value = dict(event_name='QuickDraft_SYNTHETIC_20261024', pack_number=0, pick_number=0,
                 card_ids=cards or [10, 10, 11])
    value.update(extra)
    return ('20261024 010203.123,INFO,seventeenlands.mtga_follower,Draft ' + kind + ': ' + repr(value) + '\n').encode()


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.logs = self.root / 'logs'
        self.logs.mkdir()
        self.data = self.root / 'data'
        self.path = self.logs / 'seventeenlands.log'

    def tearDown(self):
        self.temp.cleanup()

    def capture(self, **kw):
        return c.capture(self.logs, self.data, **kw)

    def rows(self):
        with sqlite3.connect(self.data / 'draft-capture.sqlite3') as db:
            return db.execute('SELECT body FROM observations ORDER BY seq').fetchall()

    def test_allowlist_preserves_duplicate_cards(self):
        value = c.normalize(line(payload={'accessToken': 'synthetic-private'}, account='synthetic-private').decode().strip())
        self.assertEqual(value['card_ids'], [10, 10, 11])
        self.assertNotIn('synthetic-private', json.dumps(value))
        self.assertEqual(value['pack_number'], 1)

    def test_incomplete_utf8_and_restart(self):
        content = line(payload={'note': '中文'})
        cut = content.index('中'.encode()) + 1
        self.path.write_bytes(content[:cut])
        self.assertEqual(self.capture()['observations'], 0)
        with self.path.open('ab') as f:
            f.write(content[cut:])
        self.assertEqual(self.capture()['added'], 1)
        self.assertEqual(self.capture()['added'], 0)

    def test_rotation_keeps_same_cursor(self):
        self.path.write_bytes(line())
        self.capture()
        self.path.rename(self.logs / 'seventeenlands.log.2026-10-24')
        self.path.write_bytes(line('pick', [10]))
        self.assertEqual(self.capture()['observations'], 2)
        self.assertEqual(self.capture()['added'], 0)

    def test_truncation_has_gap_and_recaptures(self):
        self.path.write_bytes(line() + line('pick', [10]))
        self.capture()
        self.path.write_bytes(line(cards=[20]))
        result = self.capture()
        self.assertEqual(result['observations'], 3)
        self.assertEqual(result['gaps'], 1)

    def test_transaction_rolls_back_cursor_and_observation(self):
        self.path.write_bytes(line())
        def fail():
            raise RuntimeError('synthetic crash')
        with self.assertRaises(RuntimeError):
            self.capture(before_commit=fail)
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.capture()['added'], 1)

    def test_same_size_replacement_detected(self):
        self.path.write_bytes(line(cards=[10]))
        self.capture()
        self.path.write_bytes(line(cards=[11]))
        self.assertEqual(self.capture()['gaps'], 1)
        self.assertEqual(len(self.rows()), 2)

    def test_no_execution_or_partial_acceptance(self):
        self.path.write_bytes(line().replace(b"'card_ids': [10, 10, 11]", b"'card_ids': __import__('os').getpid()"))
        result = self.capture()
        self.assertEqual(result['observations'], 0)
        self.assertEqual(result['gaps'], 1)

    def test_oversized_line_tail_never_becomes_an_event(self):
        self.path.write_bytes(b'X' * (c.MAX_LINE + 10) + line())
        result = self.capture()
        self.assertEqual(result['observations'], 0)
        self.assertEqual(result['gaps'], 1)
        self.assertEqual(self.capture()['gaps'], 1)

    def test_oversized_incomplete_line_does_not_advance_cursor(self):
        self.path.write_bytes(b'X' * (c.MAX_LINE + 10))
        self.capture()
        with sqlite3.connect(self.data / 'draft-capture.sqlite3') as db:
            self.assertEqual(db.execute('SELECT byte_offset FROM sources').fetchone()[0], 0)
        with self.path.open('ab') as f:
            f.write(b'\n' + line())
        self.assertEqual(self.capture()['observations'], 1)

    def login(self, number):
        player = 'SYNTHETIC' + str(number).zfill(17)
        return ("20261024 010200.123,INFO,tracker,Updating user info: " + repr(dict(player_id=player, screen_name='Synthetic ' + str(number))) + "\n").encode()

    def test_account_switch_logout_and_reconnect(self):
        self.path.write_bytes(self.login(1) + line() + self.login(2) + line('pick', [11]) +
            b'20261024 010205.123,INFO,tracker,User logged out from MTGA\n' + line('pick', [12]) +
            b'20261024 010206.123,INFO,tracker,Reconnected - restoring prior user info\n' + line('pick', [13]))
        self.capture()
        rows = [json.loads(row[0]) for row in self.rows()]
        self.assertNotEqual(rows[0]['account_key'], rows[1]['account_key'])
        self.assertIsNone(rows[2]['account_key'])
        self.assertEqual(rows[1]['account_key'], rows[3]['account_key'])
        self.assertNotIn('00000000-', json.dumps(rows))

    def test_start_now_skips_old_picks_and_retains_account(self):
        self.path.write_bytes(self.login(1) + line())
        self.assertEqual(self.capture(start_now=True)['observations'], 0)
        with self.path.open('ab') as f:
            f.write(line('pick', [11]))
        self.assertEqual(self.capture(start_now=True)['observations'], 1)
        self.assertIsNotNone(json.loads(self.rows()[0][0])['account_key'])

    def test_rotation_new_file_inherits_account_and_restart_resets(self):
        self.path.write_bytes(self.login(1) + line())
        self.capture()
        self.path.rename(self.logs / 'seventeenlands.log.2026-10-24')
        self.path.write_bytes(line('pick', [11]))
        self.capture()
        with self.path.open('ab') as f:
            f.write(b'20261024 010207.123,INFO,tracker,Saving logs to synthetic\n' + line('pick', [12]))
        self.capture()
        rows = [json.loads(row[0]) for row in self.rows()]
        self.assertEqual(rows[0]['account_key'], rows[1]['account_key'])
        self.assertIsNone(rows[2]['account_key'])

    def test_arena_log_reset_drops_previous_account_before_delayed_identity(self):
        self.path.write_bytes(self.login(1) + line())
        self.capture()
        with self.path.open('ab') as f:
            f.write(b'20261024 010204.123,INFO,tracker,Starting from beginning of file as file is smaller than before (previous = 5300154; current = 0)\n' +
                    line('pick', [11]))
        self.capture()
        with self.path.open('ab') as f:
            f.write(self.login(2) + line('pick', [12]))
        self.capture()
        rows = [json.loads(row[0]) for row in self.rows()]
        self.assertIsNotNone(rows[0]['account_key'])
        self.assertIsNone(rows[1]['account_key'])
        self.assertIsNotNone(rows[2]['account_key'])
        self.assertNotEqual(rows[0]['account_key'], rows[2]['account_key'])
        self.assertEqual(self.capture()['added'], 0)

    def test_reset_does_not_restore_departed_identity_or_survive_bootstrap(self):
        reset = b'20261024 010204.123,INFO,tracker,Starting from beginning of file as file is smaller than before (previous = 8; current = 0)\n'
        reconnect = b'20261024 010205.123,INFO,tracker,Reconnected - restoring prior user info\n'
        self.path.write_bytes(self.login(1) + reset + reconnect + line())
        self.assertEqual(self.capture(start_now=True)['observations'], 0)
        with self.path.open('ab') as f:
            f.write(line('pick', [11]))
        self.capture()
        self.assertIsNone(json.loads(self.rows()[0][0])['account_key'])

    def test_bootstrap_snapshot_does_not_skip_concurrent_append(self):
        self.path.write_bytes(self.login(1) + line())
        original = c.os.fstat
        def appended(fd):
            info = original(fd)
            with self.path.open('ab') as f:
                f.write(line('pick', [11]))
            return info
        with patch.object(c.os, 'fstat', side_effect=appended):
            self.assertEqual(self.capture(start_now=True)['observations'], 0)
        self.assertEqual(self.capture(start_now=True)['observations'], 1)

    def test_multi_pick_and_unsupported_formats(self):
        self.path.write_bytes(line('pick', [10, 11]) + b'20261024 010204.123,INFO,tracker,Human draft pack (combined): {}\n')
        result = self.capture()
        self.assertEqual(result['gaps'], 1)
        self.assertEqual(json.loads(self.rows()[0][0])['card_ids'], [10, 11])


if __name__ == '__main__':
    unittest.main()
