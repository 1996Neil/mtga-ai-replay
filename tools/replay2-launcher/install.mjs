import { access, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function commandText(nodePath, launcherPath, action) {
  return `#!/bin/zsh\n# Replay 2.0 desktop launcher v1\n${shellQuote(nodePath)} ${shellQuote(launcherPath)} ${shellQuote(action)}\nresult=$?\nif (( result != 0 )); then\n  print '\n操作失败。以上为原因；按回车关闭窗口。'\n  read -r response\nfi\nexit $result\n`;
}

export async function install({ desktop = join(homedir(), 'Desktop'), nodePath = process.execPath,
  launcherPath = fileURLToPath(new URL('./launch.mjs', import.meta.url)) } = {}) {
  await access(nodePath, constants.X_OK);
  await access(launcherPath);
  await mkdir(desktop, { recursive: true });
  const entries = [['Replay 2.0.command', 'start'], ['停止 Replay 2.0.command', 'stop']];
  // Check every collision before writing either entry.
  for (const [name] of entries) {
    try {
      const previous = await readFile(join(desktop, name), 'utf8');
      if (!previous.includes('# Replay 2.0 desktop launcher v1')) throw new Error(`保留现有同名文件：${join(desktop, name)}；请先手动改名。`);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  for (const [name, action] of entries) {
    const path = join(desktop, name);
    await writeFile(path, commandText(nodePath, launcherPath, action), { mode: 0o700 });
    await chmod(path, 0o700);
    console.log(path);
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { await install(); } catch (e) { console.error(`安装入口失败：${e.message}`); process.exitCode = 1; }
}
