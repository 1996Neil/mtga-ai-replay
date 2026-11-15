import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { validateBundleFiles, validateStagedRepository } from '../src/sync-security.mjs';

const exec = promisify(execFile);
const files = value => new Map([['latest/coach.json', typeof value === 'string' ? value : JSON.stringify(value)]]);
const historyKey = '2026-10-01_232502_39f7be85';
const safePayload = {
  match: { match_id: 'synthetic-match', player_display_name: 'WedRainbow', opponent_display_name: 'Flower', game_number: 1 },
  deck: [{ arena_id: 111, name: 'Bearer of the Heavens', count: 1 }],
  states: { S1: { me: { hand: [{ arena_id: 111, name: 'Bearer of the Heavens', visibility: 'player_known' }] },
    opponent: { hand_count: 3, battlefield: [{ arena_id: 222, name: 'Lander', token: true, is_token: true }] },
    combat: { attackers: [], blockers: [] }, stack: [], priority: { source: 'last_observed', player: 'me' } } },
  cards: [{ name: 'Bearer of the Heavens', oracle_text: 'When Bearer of the Heavens dies, destroy all permanents at the beginning of the next end step.', keywords: [], mana_cost: '{7}{R}' }],
};
function forbidden(value, expectedRule) {
  let error;
  try { validateBundleFiles(files(value)); } catch (caught) { error = caught; }
  assert.equal(error?.code, 'MTGA_SYNC_SECURITY');
  assert.equal(error?.path, 'latest/coach.json');
  if (expectedRule) assert.equal(error.rule, expectedRule);
  return error;
}
async function repository(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mtga-sync-security-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await exec('git', ['init', '--quiet'], { cwd: dir });
  return dir;
}
const git = (dir, args) => exec('git', args, { cwd: dir });
async function add(dir, path, value) {
  await mkdir(join(dir, path, '..'), { recursive: true });
  await writeFile(join(dir, path), typeof value === 'string' ? value : JSON.stringify(value));
  await git(dir, ['add', '--', path]);
}
const commit = dir => git(dir, ['-c', 'user.name=Synthetic Test', '-c', 'user.email=test@users.noreply.github.com', 'commit', '--quiet', '--no-verify', '-m', 'Synthetic safe fixture']);

async function existingResearch(t, text = 'Existing immutable research.') {
  const dir = await repository(t);
  await git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await add(dir, 'README.md', 'Safe fixture.'); await commit(dir);
  const path = 'docs/research/live-coach/Existing_Research.md';
  await add(dir, path, text);
  await personalCommit(dir);
  const approval = { schema: 'MTGA_SYNC_HISTORY_APPROVAL_V1', approved: true,
    repository: 'fixture-owner/private-coaching', branch: 'main', approved_at: '2026-10-05T00:00:00.000Z',
    commits: [(await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()], files: [{ path, mode: '100644',
      blob: (await git(dir, ['rev-parse', `HEAD:${path}`])).stdout.trim(),
      sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) }] };
  return { dir, path, approval, options: { historyApproval: approval, repository: approval.repository, branch: approval.branch } };
}
function personalCommit(dir) {
  return exec('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Existing synthetic research'], {
    cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'Synthetic Research', GIT_AUTHOR_EMAIL: 'research@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic Research', GIT_COMMITTER_EMAIL: 'research@example.invalid' } });
}

test('only explicit repository-bound immutable history approval accepts an existing research commit', async t => {
  const h = await existingResearch(t);
  await assert.rejects(validateStagedRepository(h.dir), e => e.code === 'MTGA_SYNC_SECURITY');
  assert.equal((await validateStagedRepository(h.dir, h.options)).ok, true);
  for (const options of [{ ...h.options, repository: 'another/repository' }, { ...h.options, branch: 'other' },
    { ...h.options, historyApproval: { ...h.approval, approved: false } },
    { ...h.options, historyApproval: { ...h.approval, commits: [] } },
    { ...h.options, historyApproval: { ...h.approval, files: [{ ...h.approval.files[0], path: 'latest/coach.json' }] } }]) {
    await assert.rejects(validateStagedRepository(h.dir, options), e => e.rule === 'invalid-history-approval');
  }
  await add(h.dir, 'latest/coach.json', safePayload); await commit(h.dir);
  assert.equal((await validateStagedRepository(h.dir, h.options)).ok, true);
});

test('history approval rejects newly introduced personal identities and forged document fingerprints', async t => {
  const h = await existingResearch(t);
  for (const patch of [{ blob: 'a'.repeat(40) }, { sha256: 'b'.repeat(64) }, { bytes: 1 }, { mode: '100755' }]) {
    await assert.rejects(validateStagedRepository(h.dir, { ...h.options,
      historyApproval: { ...h.approval, files: [{ ...h.approval.files[0], ...patch }] } }), e => e.code === 'MTGA_SYNC_SECURITY');
  }
  await add(h.dir, 'README.md', 'Another safe fixture.'); await personalCommit(h.dir);
  await assert.rejects(validateStagedRepository(h.dir, h.options), e => e.rule === 'commit-personal-identity');
});

test('approved research documents cannot be staged as modifications, deletions or renames', async t => {
  const h = await existingResearch(t), baseline = h.approval.commits[0];
  for (const action of ['modify', 'delete', 'rename']) {
    await git(h.dir, ['reset', '--hard', baseline]);
    if (action === 'modify') await add(h.dir, h.path, 'Changed research.');
    if (action === 'delete') await git(h.dir, ['rm', '--', h.path]);
    if (action === 'rename') await git(h.dir, ['mv', '--', h.path, 'docs/research/live-coach/Renamed.md']);
    await assert.rejects(validateStagedRepository(h.dir, h.options), e => e.rule === 'unapproved-file-path');
  }
});

test('a later committed deletion of an approved document is rejected even though its old blob remains', async t => {
  const h = await existingResearch(t);
  await git(h.dir, ['rm', '--', h.path]); await commit(h.dir);
  await assert.rejects(validateStagedRepository(h.dir, h.options), e => e.rule === 'changed-approved-document');
});

test('approved document text is scanned and cannot grant its bytes a JSON data exception through dedup', async t => {
  const h = await existingResearch(t, '{"account_id":"synthetic-account"}');
  assert.equal((await validateStagedRepository(h.dir, h.options)).ok, true);
  await add(h.dir, 'latest/coach.json', '{"account_id":"synthetic-account"}');
  await assert.rejects(validateStagedRepository(h.dir, h.options), e => e.rule === 'internal-account-or-machine-identifier');
  const bad = await existingResearch(t, 'A private path /Users/synthetic/private.log');
  await assert.rejects(validateStagedRepository(bad.dir, bad.options), e => e.rule === 'local-machine-path');
});

test('each approved document fingerprint is checked even when two paths share one blob', async t => {
  const h = await existingResearch(t), path = 'docs/research/live-coach/Second_Research.md';
  await add(h.dir, path, 'Existing immutable research.'); await personalCommit(h.dir);
  const approval = { ...h.approval,
    commits: [...h.approval.commits, (await git(h.dir, ['rev-parse', 'HEAD'])).stdout.trim()],
    files: [...h.approval.files, { ...h.approval.files[0], path }] };
  const options = { ...h.options, historyApproval: approval };
  assert.equal((await validateStagedRepository(h.dir, options)).ok, true);
  for (const patch of [{ sha256: 'b'.repeat(64) }, { bytes: 1 }]) {
    await assert.rejects(validateStagedRepository(h.dir, { ...options, historyApproval: {
      ...approval, files: [approval.files[0], { ...approval.files[1], ...patch }],
    } }), e => e.rule === 'changed-approved-document');
  }
});

test('only exact bundle/text paths pass, preserving full gameplay, Oracle text and display names', () => {
  const fixture = new Map([['README.md', 'Private player-perspective MTGA coaching data.'], ['.gitignore', 'node_modules/\n.env\n*.log\n'],
    ['index.json', Buffer.from('{"matches":[]}')], ...['summary', 'coach', 'cards', 'manifest'].flatMap(name => [
      [`latest/${name}.json`, JSON.stringify(safePayload)], [`matches/${historyKey}/${name}.json`, Buffer.from(JSON.stringify(safePayload))],
    ])]);
  const before = JSON.stringify(safePayload);
  assert.deepEqual(validateBundleFiles(fixture), { ok: true, fileCount: 11 });
  assert.equal(JSON.stringify(safePayload), before);
  assert.deepEqual(validateBundleFiles({ 'latest/coach.json': JSON.stringify(safePayload) }), { ok: true, fileCount: 1 });
});

test('raw logs, databases, cache, images, env and traversal paths cannot enter any upload tree', () => {
  for (const path of ['Player.log', 'Player-prev.log', 'UTC_Log - sample.log', 'Raw_CardDatabase.mtga', 'replays.sqlite3',
    'server.json', 'cards/111.jpg', 'node_modules/foo.json', '.env', 'latest/card.png', 'latest/coach.json/extra',
    '/Users/private/coach.json', 'C:\\Users\\private\\coach.json', '../latest/coach.json', 'latest/../coach.json',
    'matches/../../coach.json', 'matches/.hidden/coach.json', 'matches/bad%2Fkey/coach.json', 'LATEST/coach.json', 'latest/COACH.json']) {
    assert.throws(() => validateBundleFiles(new Map([[path, '{}']])), error => error.code === 'MTGA_SYNC_SECURITY' && error.rule === 'unapproved-file-path', path);
  }
});

test('only canonical per-match JSON part paths are allowed and all content guards still apply', () => {
  const fixture = new Map(['0001', '09999', '100000'].map(number => [`matches/${historyKey}/parts/part-${number}.json`, JSON.stringify(safePayload)]));
  assert.deepEqual(validateBundleFiles(fixture), { ok: true, fileCount: 3 });
  for (const path of [`latest/parts/part-0001.json`, `matches/${historyKey}/part-0001.json`,
    `matches/${historyKey}/parts/part-001.json`, `matches/${historyKey}/parts/part-1000000.json`,
    `matches/${historyKey}/parts/part-0001.JSON`, `matches/${historyKey}/parts/part-0001.json.log`,
    `matches/${historyKey}/parts/part-0001.log.json`, `matches/${historyKey}/parts/raw-0001.json`,
    `matches/${historyKey}/parts/part-0001.jpg`, `matches/${historyKey}/parts/Player.log`,
    `matches/${historyKey}/parts/part-0001.json/extra`, `matches/${historyKey}/parts/../part-0001.json`,
    `matches/../parts/part-0001.json`, `matches/${historyKey}/parts/part-%30%30%30%31.json`]) {
    assert.throws(() => validateBundleFiles(new Map([[path, '{}']])), error => error.rule === 'unapproved-file-path', path);
  }
  const path = `matches/${historyKey}/parts/part-0001.json`;
  for (const value of [{ password: 'synthetic-part-secret' }, { machine_id: 'synthetic-machine' },
    { raw_log: 'synthetic log' }, { image_uris: {} }, { details: '/Users/SyntheticPartPrivate/Player.log' }]) {
    assert.throws(() => validateBundleFiles(new Map([[path, JSON.stringify(value)]])), error => {
      assert.equal(error.code, 'MTGA_SYNC_SECURITY'); assert.equal(error.path, path);
      assert.doesNotMatch(error.message, /synthetic-part-secret|synthetic-machine|SyntheticPartPrivate/); return true;
    });
  }
});

test('binary/control payloads, malformed JSON and non-UTF8 bytes are rejected even under allowed names', () => {
  for (const bytes of [Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from([0xff, 0xfe, 0x61]), Buffer.from('{}\0')]) {
    assert.throws(() => validateBundleFiles(new Map([['latest/cards.json', bytes]])), error => error.code === 'MTGA_SYNC_SECURITY');
  }
  forbidden('not JSON', 'invalid-json');
  forbidden({ embedded: 'data:image/png;base64,synthetic-image' }, 'image-or-binary-data');
  forbidden({ embedded: '<svg xmlns="synthetic">test</svg>' }, 'image-or-binary-data');
  forbidden({ image_uris: { normal: 'https://public.example.invalid/card.jpg' } }, 'image-or-binary-data');
  assert.throws(() => validateBundleFiles(new Map([['latest/coach.json', { oracle_text: 'not a byte buffer' }]])), /non-text-file/);
});

test('credential text and escaped local paths are rejected without echoing their payload', () => {
  const sentinels = ['github_pat_SYNTHETIC_SUPER_SECRET', 'ghp_SYNTHETIC_SUPER_SECRET', 'gho_SYNTHETIC_SUPER_SECRET',
    'Bearer SYNTHETIC_SUPER_SECRET', 'Bearer short', 'API_KEY=synthetic-value', 'OPENAI_API_KEY=synthetic-value',
    'Authorization: synthetic-value', 'Cookie: synthetic-value', '/Users/PrivateSentinel/Player.log',
    'C:\\Users\\PrivateSentinel\\Player.log', '\\\\PrivateServer\\PrivateShare', 'file:///secret/path',
    'private-sentinel@example.invalid', '-----BEGIN PRIVATE KEY-----', 'https://private-user:private-pass@github.com/private/repo',
    '/opt/homebrew/private', '/custom-machine-root/private'];
  for (const sentinel of sentinels) {
    const error = forbidden({ details: sentinel });
    assert.equal(error.message.includes(sentinel), false); assert.equal(JSON.stringify(error).includes(sentinel), false);
    assert.equal(error.cause, undefined);
  }
  const escapedPath = '{"details":"/\\u0055sers/PrivateSentinel/Player.log"}';
  forbidden(escapedPath, 'local-machine-path');
  forbidden('{"discarded":"\\u0067hp_SYNTHETIC_SUPER_SECRET","discarded":"safe"}', 'credential-text');
  forbidden('{"discarded":"/custom-machine-root/private","discarded":"safe"}', 'local-machine-path');
  forbidden('{"player":{"account_id":"synthetic-private-identifier"},"player":"Synthetic Me"}', 'internal-account-or-machine-identifier');
  forbidden('{"player":{"machine\\u005fid":"synthetic-machine"},"player":"Synthetic Me"}', 'internal-account-or-machine-identifier');
  forbidden('{"discarded":{"greToClientEvent":{}},"discarded":"safe"}', 'raw-client-record');
  forbidden('{"discarded":{"image_uris":{}},"discarded":"safe"}', 'image-or-binary-data');
  forbidden('{"token":"synthetic-private-token","token":true}', 'credential-key');
  assert.deepEqual(validateBundleFiles(files({ oracle_text: 'Whenever you say "account_id": draw a card. Create a token named "machine_id".', token: true })), { ok: true, fileCount: 1 });
});

test('credential/internal account/raw protocol keys are denied recursively while gameplay token flags survive', () => {
  const credentialKeys = ['password', 'credentials', 'access_token', 'refresh-token', 'GitHubToken', 'OPENAI_API_KEY', 'Cookie', 'account_auth', 'token'];
  for (const key of credentialKeys) {
    const error = forbidden({ turns: [{ event: { [key]: 'synthetic-secret-sentinel' } }] });
    assert.doesNotMatch(error.message, /synthetic-secret-sentinel/);
  }
  forbidden('{"nested":{"pass\\u0077ord":"synthetic-secret-sentinel"}}', 'credential-key');
  for (const key of ['account_id', 'userId', 'internal_auth_id', 'machineIdentifier', 'device_id', 'email', 'session_id']) {
    forbidden({ nested: { [key]: 'synthetic-identifier' } }, 'internal-account-or-machine-identifier');
  }
  for (const key of ['greToClientEvent', 'gameStateMessage', 'matchGameRoomStateChangedEvent', 'telemetry', 'raw_log']) forbidden({ [key]: {} }, 'raw-client-record');
  assert.deepEqual(validateBundleFiles(files({ token: false, tokens: [{ name: 'Lander' }], is_token: true, arena_id: 1, instance_id: 2, match_id: 'public-match-id', logical_id: 'C2', oracle_id: 'public-oracle-id' })), { ok: true, fileCount: 1 });
});

test('real Git index and complete tracked history pass without inspecting an unstaged replacement', async t => {
  const dir = await repository(t);
  await add(dir, 'README.md', 'Private coaching data.');
  await add(dir, 'latest/coach.json', safePayload);
  await commit(dir);
  await add(dir, `matches/${historyKey}/coach.json`, safePayload);
  await add(dir, `matches/${historyKey}/parts/part-0001.json`, safePayload);
  // Git uploads its index/objects, not a later unstaged worktree replacement.
  await writeFile(join(dir, 'latest/coach.json'), '{"password":"unstaged-never-uploaded"}');
  assert.deepEqual(await validateStagedRepository(dir), { ok: true, fileCount: 4 });
});

test('an unchanged tracked historical match is scanned even when the staged update is safe', async t => {
  const dir = await repository(t);
  await add(dir, `matches/${historyKey}/coach.json`, { nested: { token: 'synthetic-secret-sentinel' } });
  await commit(dir);
  await add(dir, 'latest/coach.json', safePayload);
  await assert.rejects(validateStagedRepository(dir), error => error.code === 'MTGA_SYNC_SECURITY' && error.path === `matches/${historyKey}/coach.json` && !error.message.includes('synthetic-secret-sentinel'));
});

test('deleting forbidden or secret files cannot hide bytes in a commit that would still be pushed', async t => {
  const dir = await repository(t);
  await add(dir, 'latest/coach.json', { password: 'synthetic-old-secret' }); await commit(dir);
  await add(dir, 'latest/coach.json', safePayload);
  await assert.rejects(validateStagedRepository(dir), error => error.rule === 'credential-key' && !error.message.includes('synthetic-old-secret'));
  const second = await repository(t);
  await add(second, 'Player.log', 'synthetic raw log'); await commit(second);
  await git(second, ['rm', '--quiet', '--', 'Player.log']);
  await add(second, 'latest/coach.json', safePayload);
  await assert.rejects(validateStagedRepository(second), error => error.rule === 'unapproved-file-path');
});

test('symlink, gitlink and unmerged entries are rejected before any target is read', async t => {
  const dir = await repository(t);
  await mkdir(join(dir, 'latest')); await symlink('/Users/SyntheticPrivateSentinel/secret', join(dir, 'latest/coach.json'));
  await git(dir, ['add', '--', 'latest/coach.json']);
  await assert.rejects(validateStagedRepository(dir), error => error.rule === 'symlink-or-gitlink' && !error.message.includes('SyntheticPrivateSentinel'));
  const sha = 'a'.repeat(40);
  for (const listing of [`160000 ${sha} 0\tlatest/coach.json\0`, `100644 ${sha} 2\tlatest/coach.json\0`]) {
    const runGit = async args => args[0] === 'diff' ? Buffer.alloc(0) : Buffer.from(listing);
    await assert.rejects(validateStagedRepository('unused', { runGit }), error => ['symlink-or-gitlink', 'unmerged-index-entry'].includes(error.rule));
  }
});

test('Git errors and forbidden credential-bearing filenames produce sanitized errors only', async () => {
  const runGit = async () => { throw new Error('fatal: https://private-user:ghp_SYNTHETIC_SUPER_SECRET@github.com/private/repo /Users/PrivateSentinel'); };
  await assert.rejects(validateStagedRepository('/Users/PrivateSentinel', { runGit }), error => {
    assert.equal(error.rule, 'git-inspection-failed'); assert.equal(error.path, '[unapproved path]');
    assert.doesNotMatch(error.message, /PrivateSentinel|ghp_|private-user/); assert.equal(error.cause, undefined); return true;
  });
  assert.throws(() => validateBundleFiles(new Map([['ghp_SYNTHETIC_SUPER_SECRET.log', '{}']])), error => !error.message.includes('ghp_'));
  assert.throws(() => validateBundleFiles(new Map([['matches/ghp_SYNTHETIC_SUPER_SECRET/coach.json', '{}']])), error => error.path === '[redacted path]' && !error.message.includes('ghp_'));
});

test('all reachable author and committer identities use GitHub noreply without leaking a historical email', async t => {
  for (const field of ['AUTHOR', 'COMMITTER']) {
    const dir = await repository(t);
    await add(dir, 'README.md', 'Safe private coaching data.');
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Synthetic Owner', GIT_COMMITTER_NAME: 'Synthetic Owner',
      GIT_AUTHOR_EMAIL: '12345+synthetic-owner@users.noreply.github.com', GIT_COMMITTER_EMAIL: 'synthetic-owner@users.noreply.github.com' };
    env[`GIT_${field}_EMAIL`] = 'synthetic-personal-sentinel@example.invalid';
    await exec('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Safe synthetic message'], { cwd: dir, env });
    await add(dir, 'latest/coach.json', safePayload);
    await commit(dir);
    await assert.rejects(validateStagedRepository(dir), error => {
      assert.equal(error.rule, 'commit-personal-identity'); assert.equal(error.path, '[commit metadata]');
      assert.doesNotMatch(error.message, /synthetic-personal-sentinel|example.invalid/); return true;
    });
  }
});

test('historical commit messages and extra metadata are scanned even when every tracked blob is safe', async t => {
  for (const message of ['ghp_SYNTHETIC_COMMIT_SECRET', '/Users/SyntheticCommitPrivate/Player.log', 'synthetic-commit-email@example.invalid']) {
    const dir = await repository(t);
    await add(dir, 'README.md', 'Safe private coaching data.');
    await git(dir, ['-c', 'user.name=Synthetic Test', '-c', 'user.email=test@users.noreply.github.com', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', message]);
    await add(dir, 'latest/coach.json', safePayload); await commit(dir);
    await assert.rejects(validateStagedRepository(dir), error => {
      assert.equal(error.path, '[commit metadata]'); assert.doesNotMatch(error.message, /SYNTHETIC_COMMIT_SECRET|SyntheticCommitPrivate|synthetic-commit-email/);
      assert.equal(error.cause, undefined); return true;
    });
  }
});

test('bounded positive memo preserves key types, escaped duplicates, overflow and complete raw-text checks', () => {
  const safe = Array.from({ length: 2100 }, (_, i) => [`safe${i}`, `value${i}`]);
  const overflow = Object.fromEntries(safe);
  const cases = [
    '{"token":true,"token":"hidden credential","token":false}',
    '{"token":false,"t\\u006fken":"hidden credential","token":true}',
    JSON.stringify({ safe: ['Repeated safe title','Repeated safe title','Bearer abcdefghijklmnop'] }),
    JSON.stringify({ ...overflow, authorization: 'bad' }),
    JSON.stringify({ ...overflow, value: 'x'.repeat(300)+' ghp_SyntheticForbiddenValue' }),
    '{"safe":"value","Authorization":"value"}',
    '{"safe":"'+'x'.repeat(300)+'/Users/synthetic/private"}',
  ];
  for (const raw of cases) assert.throws(() => validateBundleFiles(files(raw)), error => error.code === 'MTGA_SYNC_SECURITY');
  assert.equal(validateBundleFiles(files({ token: false, rows: Array(3000).fill({ name: 'Bearer of the Heavens', token: true }) })).ok, true);
});

test('a shallow history boundary cannot hide a parent from full-history validation', async t => {
  const dir = await repository(t);
  await add(dir, 'README.md', 'Safe initial fixture.'); await commit(dir);
  await add(dir, 'README.md', 'Safe second fixture.'); await commit(dir);
  assert.equal((await validateStagedRepository(dir)).ok, true);
  const head = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(dir, '.git', 'shallow'), `${head}\n`);
  await assert.rejects(validateStagedRepository(dir), error =>
    error.code === 'MTGA_SYNC_SECURITY' && error.rule === 'incomplete-git-history');
});
