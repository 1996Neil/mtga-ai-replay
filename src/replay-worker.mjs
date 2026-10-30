import { Worker, parentPort, workerData } from 'node:worker_threads';

export function replayWorker(operation, options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { operation, options }, execArgv: [] });
    let settled = false;
    worker.once('message', message => {
      settled = true;
      message.error ? reject(Error(message.error)) : resolve(message.result);
    });
    worker.once('error', reject);
    worker.once('exit', code => { if (!settled) reject(Error(`Replay worker exited (${code})`)); });
  });
}
if (parentPort && workerData) {
  try {
    const { operation, options } = workerData;
    let result;
    if (operation === 'ingest') result = await (await import('./incremental-replay-import.mjs')).importIncrementalReplays(options);
    else if (operation === 'retention') result = await (await import('./replay-retention.mjs')).cleanReplayRetention(options);
    else if (operation === 'remote') result = await (await import('./replay-remote.mjs')).importRemoteReplays(options);
    else throw Error('Unknown replay operation');
    parentPort.postMessage({ result });
  } catch {
    parentPort.postMessage({ error: '本地回放处理未全部完成，请重新查看状态并重试。' });
  }
}
