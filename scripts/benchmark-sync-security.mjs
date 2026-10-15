// Synthetic Git objects and local bare remotes only. No GitHub, card API, model,
// TTS, native collection reader, user archive, or global Git configuration.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createGzip } from 'node:zlib';
import { once } from 'node:events';

const [baselinePath, outputPath] = process.argv.slice(2);
if (!baselinePath || !outputPath) throw new Error('Usage: node scripts/benchmark-sync-security.mjs BASELINE_MODULE OUTPUT_JSON');
const modules = { before: await import(pathToFileURL(resolve(baselinePath)).href), after: await import('../src/sync-security.mjs') };
const output = resolve(outputPath), dir = await mkdtemp(join(tmpdir(), 'sync-security-benchmark-'));
await mkdir(resolve(output, '..'), { recursive: true });
const rawLog = createWriteStream(output + '.commands.jsonl.gz'), compressed = createGzip(); compressed.pipe(rawLog);
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
  GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Synthetic Benchmark', GIT_COMMITTER_NAME: 'Synthetic Benchmark',
  GIT_AUTHOR_EMAIL: 'benchmark@users.noreply.github.com', GIT_COMMITTER_EMAIL: 'benchmark@users.noreply.github.com' };
async function record(value) { if (!compressed.write(JSON.stringify(value) + '\n')) await once(compressed, 'drain'); }
const metric = () => ({ calls: 0, commands: {}, stdout_bytes: 0, stdin_bytes: 0, object_reads: {}, object_bytes: {}, validations: [] });
async function git(cwd, args, input, stats) {
  const started_at_utc = new Date().toISOString(), start = performance.now();
  const result = await new Promise(resolveCommand => {
    const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
      { cwd, env, encoding: 'buffer', timeout: 20000, maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) => resolveCommand({ error, stdout: stdout ?? Buffer.alloc(0), stderr: stderr ?? Buffer.alloc(0) }));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
  const elapsed_ms = performance.now() - start;
  await record({ cwd, args, started_at_utc, elapsed_ms, exit_code: result.error?.code ?? 0,
    stdin_base64: Buffer.from(input ?? '').toString('base64'), stdout_base64: result.stdout.toString('base64'), stderr_base64: result.stderr.toString('base64') });
  if (result.error) throw result.error;
  if (stats) {
    const label = args[0] === 'cat-file' ? args.slice(0, 2).join(' ') : args[0];
    stats.calls++; stats.commands[label] = (stats.commands[label] ?? 0) + 1;
    stats.stdout_bytes += result.stdout.length; stats.stdin_bytes += Buffer.byteLength(input ?? '');
    if (args[0] === 'cat-file' && args[1] === '--batch') {
      let cursor = 0;
      while (cursor < result.stdout.length) {
        const end = result.stdout.indexOf(10, cursor), header = result.stdout.subarray(cursor, end).toString();
        const [, kind, count] = header.split(' '), bytes = Number(count);
        assert.ok(['blob', 'commit', 'tree'].includes(kind) && Number.isSafeInteger(bytes));
        stats.object_reads[kind] = (stats.object_reads[kind] ?? 0) + 1;
        stats.object_bytes[kind] = (stats.object_bytes[kind] ?? 0) + bytes;
        cursor = end + 1 + bytes + 1;
      }
    }
  }
  return result.stdout;
}
function importHistory(count) {
  let text = '';
  const matches = [];
  const file = (path, content) => `M 100644 inline ${path}\ndata ${Buffer.byteLength(content)}\n${content}\n`;
  for (let index = 1; index <= count; index++) {
    const id = `fixture-${String(index).padStart(5, '0')}`;
    matches.push({ id, path: `matches/${id}` });
    text += `commit refs/heads/main\ncommitter Synthetic Benchmark <benchmark@users.noreply.github.com> ${1700000000 + index} +0000\ndata 23\nSynthetic replay commit\n`;
    const values = { 'summary.json': JSON.stringify({ id, outcome: 'Win' }),
      'coach.json': JSON.stringify({ id, steps: [{ description: 'Synthetic board state. '.repeat(160) }] }),
      'cards.json': JSON.stringify({ cards: [{ name: 'Forest', oracle_text: 'Add green mana.' }] }),
      'manifest.json': JSON.stringify({ id, fixture: true }) };
    for (const [name, content] of Object.entries(values)) {
      text += file(`matches/${id}/${name}`, content) + file(`latest/${name}`, content);
    }
    text += file(`matches/${id}/parts/part-0001.json`, JSON.stringify({ id, nodes: ['Synthetic state '.repeat(240)] }));
    text += file('index.json', JSON.stringify({ matches })) + file('README.md', 'Synthetic security benchmark.') + '\n';
  }
  return text;
}
const results = [];
try {
  for (const size of [10, 100, 500]) {
    const seed = join(dir, `${size}-seed.git`); await git(dir, ['init', '--bare', '-qb', 'main', seed]);
    await git(seed, ['fast-import', '--quiet'], importHistory(size));
    for (const variant of size === 100 ? ['after', 'before'] : ['before', 'after']) {
      const remote = join(dir, `${size}-${variant}.git`), checkout = join(dir, `${size}-${variant}`);
      await git(dir, ['clone', '--bare', '--quiet', seed, remote]);
      await git(dir, ['clone', '--quiet', remote, checkout]);
      const stats = metric(), session = modules[variant].createSyncValidationSession();
      async function guard(phase) {
        const start = performance.now();
        await modules[variant].validateStagedRepository(checkout, { validationSession: session,
          runGit: (args, settings) => git(checkout, args, settings.input, stats),
          onValidation: event => stats.validations.push({ phase, ...event }) });
        return { phase, ms: performance.now() - start };
      }
      const phases = [await guard('before-fetch')];
      await git(checkout, ['fetch', '--prune', 'origin']); phases.push(await guard('after-fetch'));
      await writeFile(join(checkout, 'latest', 'coach.json'), JSON.stringify({ safe: true, updated: size }));
      await git(checkout, ['add', '--', 'latest/coach.json']); phases.push(await guard('after-stage'));
      await git(checkout, ['commit', '-qm', 'Synthetic guard update']); phases.push(await guard('before-push'));
      await git(checkout, ['push', '--quiet', 'origin', 'main']);
      const local = (await git(checkout, ['rev-parse', 'HEAD'])).toString().trim();
      const published = (await git(dir, ['--git-dir', remote, 'rev-parse', 'refs/heads/main'])).toString().trim();
      assert.equal(published, local);
      assert.equal((await git(dir, ['--git-dir', remote, 'show', 'HEAD:latest/coach.json'])).toString(), JSON.stringify({ safe: true, updated: size }));
      const row = { size, variant, phases, guard_ms: phases.reduce((sum, p) => sum + p.ms, 0), local_bare_remote_verified: true, ...stats };
      results.push(row); console.log(JSON.stringify(row));
    }
  }
  await writeFile(output, JSON.stringify({ generated_at_utc: new Date().toISOString(),
    method: 'Four complete safety guards with an invocation session; separate identical local Git histories and bare remotes. Synthetic object benchmark, not full replay generation or macOS/network UX.',
    node: process.version, platform: process.platform, results }, null, 2) + '\n');
} finally {
  compressed.end(); await once(rawLog, 'close'); await rm(dir, { recursive: true, force: true });
}
