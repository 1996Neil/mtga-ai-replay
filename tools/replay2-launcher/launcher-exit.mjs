import { setTimeout as pause } from 'node:timers/promises';

/** Only called AFTER an owned PID has passed identity checks and received
 * SIGTERM. A health response can outlive the process it describes. Retry that
 * narrow observation race, but never declare success until the port is gone. */
export async function waitForOwnedServiceExit({ probe, service, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let current;
    try { current = await probe(); }
    catch (error) {
      if (!['ECONNRESET', 'REPLAY_PROCESS_IDENTITY_UNAVAILABLE'].includes(error.code)) throw error;
      current = service;
    }
    if (!current) return;
    if (current.pid !== service.pid || current.started !== service.started) throw Error('退出期间进程身份改变，未终止其他服务。');
    if (Date.now() > deadline) throw Error('服务尚未完成正常退出；未强制终止。请查看原终端或本机启动日志。');
    await pause(100);
  }
}
