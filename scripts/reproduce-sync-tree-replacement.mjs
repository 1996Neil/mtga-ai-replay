// A bounded, entirely synthetic security counterexample. Both destinations are
// temporary local bare repositories; only a successful validator can trigger
// a push. No real data, user repository, global Git config or network is used.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const [baselinePath, outputPath] = process.argv.slice(2);
if (!baselinePath || !outputPath) throw new Error('Usage: node scripts/reproduce-sync-tree-replacement.mjs BASELINE_MODULE OUTPUT_JSON');
const variants = { before: await import(pathToFileURL(resolve(baselinePath)).href), after: await import('../src/sync-security.mjs') };
const output = resolve(outputPath), root = await mkdtemp(join(tmpdir(), 'sync-tree-replacement-proof-'));
await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output + '.commands.jsonl', '');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Synthetic Security Test', GIT_COMMITTER_NAME: 'Synthetic Security Test',
  GIT_AUTHOR_EMAIL: 'test@users.noreply.github.com', GIT_COMMITTER_EMAIL: 'test@users.noreply.github.com' };
async function git(cwd, args, input) {
  const start = performance.now(), started_at_utc = new Date().toISOString();
  const result = await new Promise(resolveCommand => {
    const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
      { cwd, env, timeout: 10000, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolveCommand({ error, stdout: stdout ?? Buffer.alloc(0), stderr: stderr ?? Buffer.alloc(0) }));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
  await appendFile(output + '.commands.jsonl', JSON.stringify({ cwd, args, started_at_utc, elapsed_ms: performance.now() - start,
    exit_code: result.error?.code ?? 0, stdin_base64: Buffer.from(input ?? '').toString('base64'),
    stdout_base64: result.stdout.toString('base64'), stderr_base64: result.stderr.toString('base64') }) + '\n');
  if (result.error) throw result.error;
  return result.stdout;
}
const hash = async (cwd, args, input) => (await git(cwd, args, input)).toString().trim();
const result = { timestamp_utc: new Date().toISOString(), constraint: 'synthetic main ancestry; local bare push only after validation success', variants: {} };
try {
  const repo = join(root, 'source'); await git(root, ['init', '-qb', 'main', repo]);
  await mkdir(join(repo, 'latest')); await writeFile(join(repo, 'latest/coach.json'), '{"safe":true}');
  await git(repo, ['add', '--', 'latest/coach.json']); await git(repo, ['commit', '-qm', 'Synthetic clean root']);
  const parent = await hash(repo, ['rev-parse', 'HEAD']), safeTree = await hash(repo, ['rev-parse', 'HEAD^{tree}']);
  const secret = await hash(repo, ['hash-object', '-w', '--stdin'], '{"password":"synthetic-ancestor-secret"}');
  const latest = await hash(repo, ['mktree', '-z'], `100644 blob ${secret}\tcoach.json\0`);
  const unsafeTree = await hash(repo, ['mktree', '-z'], `040000 tree ${latest}\tlatest\0`);
  const unsafeCommit = await hash(repo, ['commit-tree', unsafeTree, '-p', parent], 'Synthetic unsafe ancestor\n');
  const cleanTip = await hash(repo, ['commit-tree', safeTree, '-p', unsafeCommit], 'Synthetic cleaned main tip\n');
  await git(repo, ['update-ref', 'refs/heads/main', cleanTip]); await git(repo, ['replace', unsafeTree, safeTree]);
  assert.equal((await git(repo, ['status', '--porcelain'])).length, 0);
  result.clean_main_tip = cleanTip; result.unsafe_ancestor = unsafeCommit;
  for (const [name, module] of Object.entries(variants)) {
    const remote = join(root, `${name}.git`); await git(root, ['init', '--bare', '-qb', 'main', remote]);
    const row = { validation_passed: false, rejection_rule: null, pushed_main: false, published_ancestor_secret: false };
    try {
      await module.validateStagedRepository(repo, { runGit: (args, settings) => git(repo, args, settings.input) });
      row.validation_passed = true;
    } catch (error) { row.rejection_rule = error.rule ?? error.code ?? error.name; }
    if (row.validation_passed) {
      await git(repo, ['push', '--quiet', remote, 'refs/heads/main:refs/heads/main']); row.pushed_main = true;
      row.published_tip_safe = JSON.parse(await git(root, ['--git-dir', remote, 'show', 'main:latest/coach.json'])).safe === true;
      row.published_ancestor_secret = JSON.parse(await git(root, ['--git-dir', remote, 'show', `${unsafeCommit}:latest/coach.json`])).password === 'synthetic-ancestor-secret';
    } else {
      row.remote_refs_empty = (await git(root, ['--git-dir', remote, 'for-each-ref', '--format=%(refname)'])).length === 0;
    }
    result.variants[name] = row;
  }
  assert.equal(result.variants.before.validation_passed, true);
  assert.equal(result.variants.before.published_ancestor_secret, true);
  assert.equal(result.variants.after.validation_passed, false);
  assert.equal(result.variants.after.rejection_rule, 'invalid-git-object');
  assert.equal(result.variants.after.pushed_main, false);
  assert.equal(result.variants.after.remote_refs_empty, true);
  await writeFile(output, JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
