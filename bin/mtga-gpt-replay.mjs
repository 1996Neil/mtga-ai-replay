#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { importReplayLogs } from '../src/replay-workflow.mjs';
import { toMarkdown, toJSON } from '../src/export.mjs';
import { defaultDataDir, listReplays, getReplay, getLatestReplay } from '../src/history.mjs';
import { openViewer } from '../src/launch-viewer.mjs';
import { configureCoachSync, getCoachSyncStatus, syncErrorMessage } from '../src/coach-sync.mjs';
import { syncCoachCatalog, printCatalogSync } from '../src/coach-catalog-sync.mjs';

if (process.argv[2] === 'live-coach') {
  try { await (await import('./mtga-live-coach.mjs')).main(process.argv.slice(3)); }
  catch (error) { console.error(`mtga-gpt-replay live-coach: ${error.message}`); process.exitCode = 1; }
} else {
const help = `Usage: mtga-gpt-replay latest [--jump-in | --all]
       mtga-gpt-replay last 5 [--all]
       mtga-gpt-replay replay latest
       mtga-gpt-replay sync [--repo owner/mtga-replay-coach]
       mtga-gpt-replay sync status
Options:
  --log PATH         Read a specific Player.log
  --log-dir PATH     Read logs from a specific directory
  --card-db PATH     Use an existing Arena card database (read-only)
  --output PATH      Output directory (default: ./output)
  --data-dir PATH    Replay history/cache directory (default: ~/.local/share/mtga-gpt-replay)
  --no-open          Export/archive without opening the Visual Replay
  --repo OWNER/NAME  Enable sync to an existing PRIVATE data-only repository
  --jump-in          Jump In only (default)
  --all              Include other event types
  --help             Show this help
Requires MTGA Detailed Logs (Plugin Support). No raw log uploads or game-file changes.
Once private sync is configured, latest automatically backfills every missing player-perspective Coach Bundle.`;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'jump-in': { type: 'boolean' }, all: { type: 'boolean' }, log: { type: 'string' },
    'log-dir': { type: 'string' }, 'card-db': { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' },
    'data-dir': { type: 'string' }, 'no-open': { type: 'boolean' },
    repo: { type: 'string' },
  } });
  if (values.help) { console.log(help); process.exit(0); }
  if (positionals[0] === 'replay') positionals.shift();
  const command = positionals[0] ?? 'latest';
  const dataDir = resolve(values['data-dir'] ?? defaultDataDir());
  if (command === 'sync') {
    if (positionals.length > 2 || (positionals[1] && positionals[1] !== 'status') || (positionals[1] === 'status' && values.repo)) throw new Error(help);
    if (positionals[1] === 'status') {
      const status = await getCoachSyncStatus({ dataDir });
      console.log(`GitHub sync: ${status.enabled ? 'enabled' : 'disabled'}\nRepository: ${status.repository ?? 'not configured'}\nVisibility: ${status.visibility ?? 'not configured'}\nLast synced: ${status.last_synced ? `${status.last_synced.match_id} at ${status.last_synced.at}` : 'none'}\nPending: ${status.pending}`);
      if (status.last_error) console.log(`Last sync issue: ${status.last_error.message}`);
    } else {
      if (values.repo) await configureCoachSync(values.repo, { dataDir });
      const status = await getCoachSyncStatus({ dataDir, verify: false });
      if (!status.enabled) throw new Error('Private sync is not configured. Run mtga-gpt-replay sync --repo owner/mtga-replay-coach with an existing PRIVATE repository.');
      const replay = await getLatestReplay({ dataDir });
      console.log('Scanning local MTGA matches...');
      const result = await syncCoachCatalog({ dataDir, cardDb: values['card-db'], refreshMatchIds: replay ? [replay.match.id] : [] });
      printCatalogSync(result);
      if (result.sync_error || result.failed.length) process.exitCode = 1;
    }
    process.exit(process.exitCode ?? 0);
  }
  const count = command === 'latest' ? 1 : Number(positionals[1]);
  if (!['latest', 'last'].includes(command) || !Number.isInteger(count) || count < 1 || count > 100 ||
      positionals.length > (command === 'latest' ? 1 : 2) || (values.all && values['jump-in']) || values.repo) throw new Error(help);
  const { paths, detailed, hasGameRecords, database } = await importReplayLogs({ dataDir,
    logPath: values.log, logDir: values['log-dir'], cardDb: values['card-db'], all: values.all });
  const summaries = (await listReplays({ dataDir, limit: 1000 })).filter(r => values.all || r.is_jump_in).slice(0, count);
  const selected = await Promise.all(summaries.map(r => getReplay(r.id, { dataDir })));
  if (!selected.length) {
    if (!paths.length) throw new Error('No MTGA logs or archived replays found. Start Arena or use --log /absolute/path/Player.log.');
    if (!detailed && !hasGameRecords) throw new Error('Detailed game logs unavailable. In Arena: Settings (gear) → Account → Detailed Logs (Plugin Support). Enable it, restart Arena, then play a Jump In game.');
    throw new Error(`No completed ${values.all ? '' : 'Jump In '}match with detailed replay data found. Play a game with Detailed Logs enabled, then run again.`);
  }
  const output = resolve(values.output ?? 'output');
  await mkdir(output, { recursive: true, mode: 0o700 });
  for (let i = 0; i < selected.length; i++) {
    const replay = selected[i];
    if (!replay.games.length || !replay.games.some(g => g.turns.length)) throw new Error('Match metadata found but detailed turns are missing. Enable Detailed Logs, restart Arena and play a new game.');
    const stem = i === 0 ? 'latest' : `replay-${i + 1}`;
    await writeFile(join(output, `${stem}.json`), toJSON(replay), { mode: 0o600 });
    await writeFile(join(output, `${stem}.md`), toMarkdown(replay), { mode: 0o600 });
    console.log(`${stem}: ${replay.match.event}, ${replay.match.result}, ${replay.match.started_at}`);
  }
  if (selected.length < count) console.log(`Found ${selected.length} of ${count} requested completed matches in logs/history.`);
  console.log(`Markdown: ${join(output, 'latest.md')}\nJSON: ${join(output, 'latest.json')}`);
  console.log(`History: ${join(dataDir, 'replays.sqlite3')}`);
  if (!values['no-open']) console.log(`Visual Replay: ${await openViewer(selected[0].match.id, { dataDir })}`);
  try {
    const status = await getCoachSyncStatus({ dataDir, verify: false });
    if (status.enabled) {
      console.log('Scanning local MTGA matches...');
      printCatalogSync(await syncCoachCatalog({ dataDir, cardDb: database, refreshMatchIds: selected.map(replay => replay.match.id) }));
    }
  } catch (error) {
    console.warn(`GitHub Coach sync pending: ${syncErrorMessage(error)}`);
    console.warn('Local replay is ready. Retry: mtga-gpt-replay sync');
  }
} catch (error) {
  const syncCommand = process.argv.includes('sync');
  console.error(`mtga-gpt-replay: ${syncCommand ? syncErrorMessage(error) : error.message}`);
  process.exitCode = 1;
}
}
