import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const moduleUrl = process.env.SYNC_SECURITY_UNDER_TEST
  ? pathToFileURL(resolve(process.env.SYNC_SECURITY_UNDER_TEST)).href
  : new URL('../src/sync-security.mjs', import.meta.url).href;
const { validateStagedRepository, createSyncValidationSession } = await import(moduleUrl);
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
  GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Synthetic Test', GIT_COMMITTER_NAME: 'Synthetic Test',
  GIT_AUTHOR_EMAIL: 'test@users.noreply.github.com', GIT_COMMITTER_EMAIL: 'test@users.noreply.github.com' };
function command(dir, args, input, extraEnv = {}) {
  return new Promise((yes, no) => {
    const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
      { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'buffer', timeout: 10000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => error ? no(error) : yes(stdout));
    child.stdin.on('error', no); child.stdin.end(input);
  });
}
const hash = async (dir, args, input, extraEnv) => (await command(dir, args, input, extraEnv)).toString().trim();
const commit = dir => command(dir, ['commit', '-qm', 'Synthetic fixture']);
async function add(dir, path, text) {
  await mkdir(join(dir, path, '..'), { recursive: true });
  await writeFile(join(dir, path), text);
  await command(dir, ['add', '--', path]);
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'sync-security-session-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await command(dir, ['init', '-qb', 'main']);
  await add(dir, 'README.md', 'Safe fixture.');
  await add(dir, 'latest/coach.json', '{"safe":true}\n'); await commit(dir);
  return dir;
}
const rawTree = (dir, entries) => hash(dir, ['mktree', '-z'], Buffer.from(entries.join('\0') + '\0'));
const rawBlob = (dir, text) => hash(dir, ['hash-object', '-w', '--stdin'], text);
async function syntheticCommit(dir, tree, parent, message = 'Synthetic hidden branch') {
  return hash(dir, ['commit-tree', tree, ...(parent ? ['-p', parent] : [])], message + '\n');
}
const securityError = error => error.code === 'MTGA_SYNC_SECURITY';

test('raw tree inspection also handles SHA-256 Git object identifiers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sync-security-sha256-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await command(dir, ['init', '--object-format=sha256', '-qb', 'main']);
  await add(dir, 'latest/coach.json', '{"safe":true}'); await commit(dir);
  assert.equal((await hash(dir, ['rev-parse', 'HEAD'])).length, 64);
  assert.equal((await validateStagedRepository(dir, { validationSession: createSyncValidationSession() })).ok, true);
});

test('session caches semantics but re-reads raw objects at each guard and rejects post-stage secrets', async t => {
  const dir = await fixture(t), validationSession = createSyncValidationSession(), events = [], calls = [];
  const options = { validationSession, onValidation: result => events.push(result),
    runGit: (args, settings) => { calls.push([...args]); return command(dir, args, settings.input); } };
  await validateStagedRepository(dir, options); const before = calls.length;
  await validateStagedRepository(dir, options);
  assert.ok(events[0].checked > 0); assert.equal(events[1].checked, 0); assert.ok(events[1].reused > 0);
  assert.ok(calls.slice(before).some(args => args[0] === 'cat-file' && args[1] === '--batch'));
  await add(dir, 'latest/coach.json', '{"password":"synthetic-stage-secret"}');
  await assert.rejects(validateStagedRepository(dir, options), error => securityError(error) && error.rule === 'credential-key');
  await assert.rejects(validateStagedRepository(dir, options), error => error.rule === 'invalid-validation-session');
});

test('new refs retain deleted historical secrets even when HEAD and the index remain unchanged', async t => {
  const dir = await fixture(t), validationSession = createSyncValidationSession();
  await validateStagedRepository(dir, { validationSession });
  const head = await hash(dir, ['rev-parse', 'HEAD']), safeRoot = await hash(dir, ['rev-parse', 'HEAD^{tree}']);
  const secret = await rawBlob(dir, '{"account_id":"synthetic-secret-history"}');
  const latest = await rawTree(dir, [`100644 blob ${secret}\tcoach.json`]);
  const root = await rawTree(dir, [`040000 tree ${latest}\tlatest`]);
  const unsafe = await syntheticCommit(dir, root, head), cleaned = await syntheticCommit(dir, safeRoot, unsafe);
  await command(dir, ['update-ref', 'refs/heads/extra-history', cleaned]);
  assert.equal(await hash(dir, ['rev-parse', 'HEAD']), head);
  await assert.rejects(validateStagedRepository(dir, { validationSession }), error => securityError(error) && error.rule === 'internal-account-or-machine-identifier');
});

test('a shared subtree under a forbidden prefix never inherits its allowed path verdict', async t => {
  const dir = await fixture(t), validationSession = createSyncValidationSession();
  await validateStagedRepository(dir, { validationSession });
  const latest = await hash(dir, ['rev-parse', 'HEAD:latest']);
  const tree = await rawTree(dir, [`040000 tree ${latest}\tlatest`, `040000 tree ${latest}\tunapproved`]);
  const extra = await syntheticCommit(dir, tree, await hash(dir, ['rev-parse', 'HEAD']));
  await command(dir, ['update-ref', 'refs/heads/extra-prefix', extra]);
  await assert.rejects(validateStagedRepository(dir, { validationSession }), error => error.rule === 'unapproved-file-path');
});

test('historical BOM-prefixed file and directory names cannot normalize into the path allowlist', async t => {
  const outcomes = [];
  for (const kind of ['file', 'directory']) {
    const dir = await fixture(t), head = await hash(dir, ['rev-parse', 'HEAD']), safeRoot = await hash(dir, ['rev-parse', 'HEAD^{tree}']);
    const blob = await rawBlob(dir, '{"safe":true}\n');
    const latest = await rawTree(dir, [`100644 blob ${blob}\tcoach.json`]);
    const unsafeRoot = await rawTree(dir, [kind === 'file'
      ? `100644 blob ${blob}\t\uFEFFREADME.md`
      : `040000 tree ${latest}\t\uFEFFlatest`]);
    const unsafe = await syntheticCommit(dir, unsafeRoot, head, 'Synthetic historical path');
    const cleaned = await syntheticCommit(dir, safeRoot, unsafe, 'Synthetic clean tip');
    await command(dir, ['update-ref', 'refs/heads/main', cleaned]);
    // The forbidden bytes exist only in an ancestor: neither the safe tip nor
    // the unchanged index can accidentally be the reason this guard rejects.
    assert.equal((await command(dir, ['status', '--porcelain'])).length, 0);
    assert.equal(await hash(dir, ['rev-parse', 'HEAD^{tree}']), safeRoot);
    assert.ok((await command(dir, ['ls-tree', '-r', '-z', unsafe])).includes(Buffer.from('\uFEFF')));
    outcomes.push(await validateStagedRepository(dir).then(() => ({ kind, rejected: false }), error => ({ kind, rejected: securityError(error) })));
  }
  assert.deepEqual(outcomes, [{ kind: 'file', rejected: true }, { kind: 'directory', rejected: true }]);
});

test('a replaced ancestor tree cannot hide private bytes behind a clean main tip and index', async t => {
  const dir = await fixture(t);
  const safeTree = await hash(dir, ['rev-parse', 'HEAD^{tree}']);
  const secret = await rawBlob(dir, '{"password":"synthetic-replacement-secret"}');
  const latest = await rawTree(dir, [`100644 blob ${secret}\tcoach.json`]);
  const unsafeTree = await rawTree(dir, [`040000 tree ${latest}\tlatest`]);
  const unsafe = await syntheticCommit(dir, unsafeTree, await hash(dir, ['rev-parse', 'HEAD']));
  const cleaned = await syntheticCommit(dir, safeTree, unsafe, 'Synthetic clean main tip');
  await command(dir, ['update-ref', 'refs/heads/main', cleaned]);
  await command(dir, ['replace', unsafeTree, safeTree]);
  assert.equal((await command(dir, ['status', '--porcelain'])).length, 0);
  await assert.rejects(validateStagedRepository(dir), error => securityError(error) && error.rule === 'invalid-git-object');
});

for (const kind of ['blob', 'tree', 'commit']) test(`cached validation still rejects a corrupt loose ${kind} object under its old hash`, async t => {
  const dir = await fixture(t), validationSession = createSyncValidationSession();
  await validateStagedRepository(dir, { validationSession });
  const target = await hash(dir, ['rev-parse', kind === 'blob' ? 'HEAD:latest/coach.json' : kind === 'tree' ? 'HEAD^{tree}' : 'HEAD']);
  const original = await command(dir, ['cat-file', kind, target]);
  const changed = kind === 'tree'
    ? Buffer.from(original.toString('latin1').replace('100644', '100755'), 'latin1')
    : Buffer.concat([original, Buffer.from('\n')]);
  assert.notDeepEqual(changed, original);
  const path = join(dir, '.git', 'objects', target.slice(0, 2), target.slice(2));
  await writeFile(path + '.tampered', deflateSync(Buffer.concat([Buffer.from(`${kind} ${changed.length}\0`), changed])));
  await rename(path + '.tampered', path);
  await assert.rejects(validateStagedRepository(dir, { validationSession }), securityError);
});

test('new reachable commit metadata is rechecked after a session has passed', async t => {
  const dir = await fixture(t), validationSession = createSyncValidationSession();
  await validateStagedRepository(dir, { validationSession });
  const root = await hash(dir, ['rev-parse', 'HEAD^{tree}']), parent = await hash(dir, ['rev-parse', 'HEAD']);
  const extra = await hash(dir, ['commit-tree', root, '-p', parent], 'Safe message\n',
    { GIT_AUTHOR_EMAIL: 'synthetic-private@example.invalid' });
  await command(dir, ['update-ref', 'refs/heads/extra-metadata', extra]);
  await assert.rejects(validateStagedRepository(dir, { validationSession }), error => error.rule === 'commit-personal-identity');
});

test('session capabilities reject fabricated, foreign-module and concurrently used sessions', async t => {
  const dir = await fixture(t), validationSession = createSyncValidationSession();
  await assert.rejects(validateStagedRepository(dir, { validationSession: {} }), error => error.rule === 'invalid-validation-session');
  const foreign = await import(moduleUrl + '?separate-ruleset=1');
  await assert.rejects(foreign.validateStagedRepository(dir, { validationSession }), error => error.rule === 'invalid-validation-session');
  let entered, resume;
  const start = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { resume = resolve; });
  let first = true;
  const pending = validateStagedRepository(dir, { validationSession, runGit: async (args, settings) => {
    if (first) { first = false; entered(); await hold; }
    return command(dir, args, settings.input);
  } });
  await start;
  await assert.rejects(validateStagedRepository(dir, { validationSession }), error => error.rule === 'concurrent-validation-session');
  resume(); assert.equal((await pending).ok, true);
});

async function approvedFixture(t) {
  const dir = await fixture(t), path = 'docs/research/live-coach/approved.md', text = '{"account_id":"synthetic-reference-only"}';
  await add(dir, path, text);
  await command(dir, ['commit', '-qm', 'Synthetic approved research'], undefined,
    { GIT_AUTHOR_EMAIL: 'synthetic-research@example.invalid', GIT_COMMITTER_EMAIL: 'synthetic-research@example.invalid' });
  const approval = { schema: 'MTGA_SYNC_HISTORY_APPROVAL_V1', approved: true, repository: 'fixture/private', branch: 'main',
    approved_at: '2026-10-10T00:00:00.000Z', commits: [await hash(dir, ['rev-parse', 'HEAD'])],
    files: [{ path, mode: '100644', blob: await hash(dir, ['rev-parse', `HEAD:${path}`]),
      sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) }] };
  return { dir, path, text, approval, options: { repository: 'fixture/private', branch: 'main', historyApproval: approval,
    validationSession: createSyncValidationSession() } };
}

test('cached approved text does not authorize the same blob as JSON data or another approval fingerprint', async t => {
  const h = await approvedFixture(t); await validateStagedRepository(h.dir, h.options);
  await add(h.dir, 'latest/coach.json', h.text);
  await assert.rejects(validateStagedRepository(h.dir, h.options), error => error.rule === 'internal-account-or-machine-identifier');
  const other = await approvedFixture(t); await validateStagedRepository(other.dir, other.options);
  const changed = { ...other.approval, files: [{ ...other.approval.files[0], sha256: 'f'.repeat(64) }] };
  await assert.rejects(validateStagedRepository(other.dir, { ...other.options, historyApproval: changed }), error => error.rule === 'changed-approved-document');
});

test('approved paths stay immutable through deleted and reintroduced history and either merge parent', async t => {
  const h = await approvedFixture(t); await validateStagedRepository(h.dir, h.options);
  const approved = await hash(h.dir, ['rev-parse', 'HEAD']), root = await hash(h.dir, ['rev-parse', 'HEAD^{tree}']);
  await command(h.dir, ['rm', '--', h.path]); await commit(h.dir);
  const deleted = await hash(h.dir, ['rev-parse', 'HEAD']);
  const restored = await hash(h.dir, ['commit-tree', root, '-p', approved, '-p', deleted], 'Synthetic merge restores approved path\n');
  await command(h.dir, ['update-ref', 'refs/heads/main', restored]);
  await command(h.dir, ['read-tree', restored]);
  await assert.rejects(validateStagedRepository(h.dir, h.options), error => error.rule === 'changed-approved-document');
});

test('session scope cannot reuse approved metadata in another repository or without approval', async t => {
  const h = await approvedFixture(t); await validateStagedRepository(h.dir, h.options);
  await assert.rejects(validateStagedRepository(h.dir, { ...h.options, repository: 'fixture/other' }), error => error.rule === 'invalid-history-approval');
  const other = await approvedFixture(t); await validateStagedRepository(other.dir, other.options);
  await assert.rejects(validateStagedRepository(other.dir, { validationSession: other.options.validationSession }), securityError);
});
