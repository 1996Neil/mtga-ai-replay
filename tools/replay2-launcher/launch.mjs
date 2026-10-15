import { fileURLToPath } from 'node:url';
import { createLauncher } from './launcher.mjs';

const action = process.argv[2] ?? 'start';
try {
  if (!['start', 'stop', 'status'].includes(action)) throw new Error('用法：node tools/replay2-launcher/launch.mjs [start|stop|status]');
  const launcher = createLauncher({ projectRoot: fileURLToPath(new URL('../../', import.meta.url)) });
  const result = await launcher[action]();
  if (action === 'start') console.log(`Replay 2.0：${result.reused ? '复用已验证待机服务' : '待机启动成功'}，PID ${result.pid}\n${result.url}\n待机保护 ${result.standbyGuardVersion} 已确认 · 教练关闭 · 静音`);
  else if (action === 'stop') console.log(result.message ?? (result.alreadyStopped ? 'Replay 2.0 已退出。' : 'Replay 2.0 已正常退出。'));
  else console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(`Replay 2.0：${e.message}`);
  process.exitCode = 1;
}
