/** Offline local-import benchmark. Only generated Player.log records and an
 * explicitly supplied empty SQLite card DB are used; no worker or publisher.
 *
 * Run each size serially with an external process timeout, for example:
 *   timeout 60s node scripts/benchmark-local-import.mjs --size=500 --output=/tmp/local-import-500.json
 * Optional --source=/absolute/source lets the same harness measure a snapshot.
 * Omit --size to run 10, 100 and 500 in order. Fixture setup/module loading and
 * archive-count assertions are outside the measured operation windows.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const equal = value.indexOf('=');
  if (!value.startsWith('--') || equal < 0) throw new Error('Expected --name=value benchmark arguments.');
  const key = value.slice(2, equal);
  if (!['source', 'size', 'output'].includes(key)) throw new Error(`Unknown benchmark argument: ${key}`);
  return [key, value.slice(equal + 1)];
}));
const source = resolve(args.source ?? dirname(dirname(fileURLToPath(import.meta.url))));
const sizes = args.size === undefined ? [10, 100, 500] : [Number(args.size)];
assert.ok(sizes.every(size => [10, 100, 500].includes(size)), 'Size must be 10, 100 or 500.');
let fetchAttempts = 0;
globalThis.fetch = async () => {
  fetchAttempts++;
  throw new Error('Local import benchmark forbids external fetches.');
};
const from = file => import(pathToFileURL(join(source, file)).href);
const [{ importReplayLogs }, { createLocalReplayHistory }, { listReplays }, { syntheticMatchRecords }] = await Promise.all([
  from('src/replay-workflow.mjs'), from('src/viewer-local-history.mjs'),
  from('src/history.mjs'), from('tests/helpers/synthetic-log.mjs'),
]);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const resolutionMs = 1, warmupMs = 10, drainMs = 5;

async function measured(name, action) {
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();
  // Arm the sampling timer before the operation. A final drain lets a timer
  // delayed by a last synchronous section run before we disable the monitor.
  await delay(warmupMs);
  histogram.reset();
  const startedAtUtc = new Date().toISOString(), cpuStart = process.cpuUsage();
  const utilizationStart = performance.eventLoopUtilization(), start = performance.now();
  let value, elapsed, cpu, utilization, finishedAtUtc;
  try {
    value = await action();
    elapsed = performance.now() - start;
    cpu = process.cpuUsage(cpuStart);
    utilization = performance.eventLoopUtilization(utilizationStart);
    finishedAtUtc = new Date().toISOString();
    await delay(drainMs);
  } finally { histogram.disable(); }
  const samples = Number(histogram.count);
  assert.ok(samples > 0, 'Event-loop probe must have sampled; a missing sample is not zero delay.');
  return { value, measurement: { name, started_at_utc: startedAtUtc, finished_at_utc: finishedAtUtc,
    elapsed_ms: elapsed, cpu_user_ms: cpu.user / 1000, cpu_system_ms: cpu.system / 1000,
    event_loop_utilization: utilization.utilization,
    event_loop_active_ms: utilization.active, event_loop_idle_ms: utilization.idle,
    event_loop_delay_samples: samples, event_loop_max_ms: histogram.max / 1e6,
    event_loop_p99_ms: histogram.percentile(99) / 1e6, event_loop_mean_ms: histogram.mean / 1e6,
    event_loop_sampling_window_ms: performance.now() - start } };
}

function fixtureRecords(size) {
  const records = [], expected = new Map(), messageIds = new Set();
  for (let number = 0; number < size; number++) {
    const id = `synthetic-local-import-${String(number).padStart(4, '0')}`;
    // The shared helper formats a minute field literally. Generate it at zero
    // then assign an epoch-derived time so sizes over 60 cross hours legally.
    const match = syntheticMatchRecords(id, 0), startedAt = Date.UTC(2026, 9, 1, 12, number);
    match[0].timestamp = String(startedAt);
    expected.set(id, new Date(startedAt).toISOString());
    let ordinal = 0;
    for (const record of match) for (const message of record.greToClientEvent?.greToClientMessages ?? []) {
      const messageId = number * 10 + ++ordinal;
      assert.ok(!messageIds.has(messageId), 'GRE IDs must remain unique across matches.');
      messageIds.add(messageId); message.msgId = messageId;
      if (message.gameStateMessage) message.gameStateMessage.gameStateId = messageId;
    }
    records.push(...match);
  }
  assert.equal(records.length, size * 4);
  assert.equal(messageIds.size, size * 2);
  return { records, expected, messageCount: messageIds.size };
}

async function benchmark(size) {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'mtga-local-import-benchmark-')));
  let observer;
  try {
    const dataDir = join(fixture, 'archive'), logPath = join(fixture, 'Player.log');
    const cardDb = join(fixture, 'synthetic-empty-cards.sqlite3');
    const { records, expected, messageCount } = fixtureRecords(size);
    const log = 'DETAILED LOGS: ENABLED\n' + records.map(record => JSON.stringify(record)).join('\n') + '\n';
    await writeFile(logPath, log, { mode: 0o600 });
    const database = new DatabaseSync(cardDb);
    try {
      database.exec(`CREATE TABLE Cards (GrpId INTEGER, TitleId INTEGER);
        CREATE TABLE Localizations_enUS (LocId INTEGER, Formatted INTEGER, Loc TEXT);
        CREATE TABLE Enums (Value INTEGER, LocId INTEGER, Type TEXT);`);
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM Cards').get().n, 0);
    } finally { database.close(); }
    const options = { dataDir, logPath, cardDb, all: true }, imports = [];
    // Count real workflow calls without replacing parsing, fingerprints or
    // synchronous SQLite archive writes. Every call uses only fixture paths.
    async function workflow(settings) {
      assert.equal(settings.dataDir, dataDir); assert.equal(settings.logPath, logPath);
      assert.equal(settings.cardDb, cardDb); assert.equal(settings.logDir, undefined);
      const result = await importReplayLogs(settings);
      assert.deepEqual(result.paths, [logPath]); assert.equal(result.database, cardDb);
      imports.push({ cached: result.cached, archived: result.archive.archived, preserved: result.archive.preserved });
      return result;
    }
    async function archiveCount() {
      const catalog = await listReplays({ dataDir, limit: null });
      assert.equal(catalog.length, size, 'Every synthetic match must be archived.');
      assert.equal(new Set(catalog.map(replay => replay.id)).size, size);
      for (const replay of catalog) assert.equal(replay.started_at, expected.get(replay.id));
      return catalog.length;
    }
    observer = createLocalReplayHistory({ ...options, workflow });
    const idle = await measured('idle_control', () => delay(25));
    const phases = [idle.measurement];
    const full = await measured('observer_full_import', () => observer.check({ immediate: true }));
    assert.equal(full.value.status, 'succeeded', JSON.stringify(full.value));
    assert.equal(full.value.imports, 1); assert.equal(full.value.cached, false);
    assert.deepEqual(imports, [{ cached: false, archived: size, preserved: 0 }]);
    phases.push({ ...full.measurement, workflow_calls: 1, cached: false, newly_archived: size,
      canonical_archive_count: await archiveCount() });

    const noChange = await measured('observer_unchanged_signature_hit', () => observer.check());
    assert.equal(noChange.value.status, 'succeeded'); assert.equal(noChange.value.imports, 1);
    assert.equal(imports.length, 1, 'Unchanged observer must skip the import workflow.');
    phases.push({ ...noChange.measurement, workflow_calls: 0, signature_hit: true,
      canonical_archive_count: await archiveCount() });

    const cached = await measured('import_persistent_cache_hit', () => workflow(options));
    assert.equal(cached.value.cached, true); assert.equal(cached.value.archive.archived, 0);
    assert.equal(cached.value.detailed, true); assert.equal(cached.value.hasGameRecords, true);
    assert.deepEqual(imports[1], { cached: true, archived: 0, preserved: 0 });
    assert.equal(imports.length, 2); assert.equal(fetchAttempts, 0);
    phases.push({ ...cached.measurement, workflow_calls: 1, cached: true, newly_archived: 0,
      canonical_archive_count: await archiveCount() });
    return { size, log_bytes: Buffer.byteLength(log), records: records.length, gre_messages: messageCount,
      first_started_at: expected.values().next().value, last_started_at: [...expected.values()].at(-1),
      observer_min_import_interval_ms: 30000, phases };
  } finally {
    await observer?.close();
    await rm(fixture, { recursive: true, force: true });
  }
}

const output = { source, started_at_utc: new Date().toISOString(),
  command: [process.execPath, ...process.argv.slice(1)], environment: {
    node: process.version, platform: process.platform, architecture: process.arch, logical_cpus: cpus().length },
  fixture: 'Four synthetic records / two GRE states / one short game per match; no card objects; empty explicit card database.',
  measurement: { repetitions_per_size: 1, histogram_resolution_ms: resolutionMs,
    pre_operation_warmup_ms: warmupMs, post_operation_sampling_drain_ms: drainMs,
    note: 'Elapsed/CPU excludes warmup and drain; histogram includes drain. Idle control measures the local timer floor. This is a small synthetic workload, not real-game or macOS latency acceptance.' },
  results: [] };
for (const size of sizes) {
  const result = await benchmark(size);
  output.results.push(result);
  console.log(JSON.stringify({ size, ...result }));
}
assert.equal(fetchAttempts, 0);
output.finished_at_utc = new Date().toISOString(); output.external_fetch_attempts = fetchAttempts;
if (args.output) {
  const path = resolve(args.output); await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(output, null, 2) + '\n');
}
console.log(JSON.stringify({ completed: sizes, external_fetch_attempts: fetchAttempts,
  report_saved: Boolean(args.output) }));
