"""Create a NEW private observation-only source copy (never edits the checkout).
Usage: python3 scripts/instrument-cloud-memory.py SOURCE NEW_PRIVATE_OUTPUT
Run profile-cloud-memory.mjs with --source pointing at that output.
"""
from pathlib import Path
import shutil
import sys

source, output = map(lambda value: Path(value).resolve(), sys.argv[1:])
if output == source or source in output.parents:
    raise RuntimeError('Observation-only output must be outside the source checkout')
output.mkdir(mode=0o700)  # Existing output is an error, never overwritten.
for name in ('src', 'schemas'):
    shutil.copytree(source / name, output / name)
shutil.copyfile(source / 'package.json', output / 'package.json')
(output / 'node_modules').symlink_to(source / 'node_modules')
(output / 'src/profile-observer.mjs').write_text('''import {isMainThread,parentPort} from 'node:worker_threads';
import {PerformanceObserver,performance} from 'node:perf_hooks';
const gc={count:0,ms:0,max_ms:0};
new PerformanceObserver(entries=>{for(const e of entries.getEntries()){gc.count++;gc.ms+=e.duration;gc.max_ms=Math.max(gc.max_ms,e.duration);}}).observe({entryTypes:['gc']});
export function memoryPoint(stage){const value={stage,at:performance.timeOrigin+performance.now(),...process.memoryUsage(),gc:{...gc},isolate:isMainThread?'parent':'worker'};if(isMainThread)globalThis.p2MemoryPoint?.(value);else parentPort.postMessage({memoryProfile:value});}
''')

def edit(path, changes):
    target = output / path
    text = target.read_text()
    for before, after in changes:
        if before not in text:
            raise RuntimeError('Observation point missing: ' + path)
        text = text.replace(before, after, 1)
    observer = './' if path.count('/') == 1 else '../'
    target.write_text("import {memoryPoint} from '" + observer + "profile-observer.mjs';\n" + text)

edit('src/compute-pool.mjs', [
    ("slot.worker.postMessage({ id: task.id, operation: task.operation, input: task.input });", "memoryPoint('postMessage:'+task.operation+':before'); slot.worker.postMessage({ id: task.id, operation: task.operation, input: task.input }); memoryPoint('postMessage:'+task.operation+':after');"),
    ("if (slot.task?.id !== message.id) return;", "if(message.memoryProfile){globalThis.p2MemoryPoint?.(message.memoryProfile);return;} if (slot.task?.id !== message.id) return;"),
    ("const task = slot.task; slot.task = null; if(task)clearTimeout(task.timeout);task?.reject(Error('CPU worker exited'));", "memoryPoint('worker:exited'); const task = slot.task; slot.task = null; if(task)clearTimeout(task.timeout);task?.reject(Error('CPU worker exited'));"),
])
edit('src/compute-worker.mjs', [
    ('  try {', "  memoryPoint('worker:'+operation+':start');\n  try {"),
    ('    parentPort.postMessage({id,value});', "    memoryPoint('worker:'+operation+':done'); parentPort.postMessage({id,value});"),
])
edit('src/review/review-sync.mjs', [
    ("    await git(['fetch', '--prune', '--no-tags', 'origin']);", "    memoryPoint('git:fetch:before'); await git(['fetch', '--prune', '--no-tags', 'origin']); memoryPoint('git:fetch:after');"),
    ('    await validateStagedRepository(repo,', "    memoryPoint('git:history:before'); await validateStagedRepository(repo,"),
    ('    const revision = String(await git', "    memoryPoint('git:history:after'); const revision = String(await git"),
    ('    const sourceInput = { files, matchId, revision };', "    const sourceInput = { files, matchId, revision }; memoryPoint('sourceInput:collected');"),
    ("        task.status = await publish('ready', fingerprint) ? 'ready' : 'stale';", "        memoryPoint('cache:before'); task.status = await publish('ready', fingerprint) ? 'ready' : 'stale'; memoryPoint('cache:after');"),
])
edit('src/review/cloud-review-compute.mjs', [
    ('let source = readPublishedReviewSource(sourceInput);', "memoryPoint('source:verify:before'); let source = readPublishedReviewSource(sourceInput); memoryPoint('source:verify:after');"),
    ('await adaptCloudReview(report, source);', "memoryPoint('source:adapt:before'); await adaptCloudReview(report, source); memoryPoint('source:adapt:after');"),
    ('  const contentHash =', "  memoryPoint('local:bundle:before'); const contentHash ="),
    ('  if (contentHash !==', "  memoryPoint('local:bundle:after'); if (contentHash !=="),
])
edit('src/review/cloud-review.mjs', [
    ('  let replay;', "  memoryPoint('source:parts:parsed'); let replay;"),
    ('  if (replay.schema', "  memoryPoint('source:resolve:after'); if (replay.schema"),
    ('  const numbers = new Set();', "  memoryPoint('source:privacy:after'); const numbers = new Set();"),
])
privacy_start = '  validateExpandedCoach(expanded);' if 'validateExpandedCoach(expanded)' in (output / 'src/coach-bundle.mjs').read_text() else "  validateBundleFiles(new Map([['latest/coach.json', serializeCoachJson(expanded)]"
edit('src/coach-bundle.mjs', [
    ('  const safeGames =', "  memoryPoint('bundle:games:before'); const safeGames ="),
    ('  const deck = list(replay.deck)', "  memoryPoint('bundle:games:after'); const deck = list(replay.deck)"),
    (privacy_start, "  memoryPoint('bundle:privacy:before');" + privacy_start),
    ('  const { coach, parts, ranges } = semanticMultipart', "  memoryPoint('bundle:privacy:after'); const { coach, parts, ranges } = semanticMultipart"),
    ("  const files = new Map([['summary.json', summary]", "  memoryPoint('bundle:multipart:after'); const files = new Map([['summary.json', summary]"),
    ('  return { summary, coach, cards: rules, manifest, contentHash, historyKey, parts };', "  memoryPoint('bundle:hash:after'); return { summary, coach, cards: rules, manifest, contentHash, historyKey, parts };"),
])
print('Observation-only copy prepared; no replay contents are recorded by the hooks.')
