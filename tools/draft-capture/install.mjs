import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { defaultDataDir } from '../../src/history.mjs';
const run = promisify(execFile);
if (process.platform !== 'darwin') throw new Error('This installer requires macOS.');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 or newer is required.');
// LaunchAgents do not inherit a terminal's PATH. Both the GitHub executable and
// Git's credential helper need the same explicit installed-tool search path.
const toolPath = [...new Set([dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
const toolEnv = { ...process.env, PATH: toolPath };
await run('gh', ['--version'], { env: toolEnv });
await run('git', ['--version'], { env: toolEnv });
const label = 'local.mtga.draft-capture', home = homedir();
const path = join(home, 'Library/LaunchAgents', `${label}.plist`);
const logDir = join(defaultDataDir(), 'draft-service');
const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const args = [process.execPath, fileURLToPath(new URL('../../bin/mtga-draft-capture.mjs', import.meta.url)), '--watch', '--sync', '--python', '/usr/bin/python3'];
const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(s => `<string>${escape(s)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(toolPath)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ProcessType</key><string>Background</string>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${escape(join(logDir, 'capture.log'))}</string>
<key>StandardErrorPath</key><string>${escape(join(logDir, 'errors.log'))}</string>
</dict></plist>\n`;
await mkdir(logDir, { recursive: true, mode: 0o700 });
await mkdir(join(home, 'Library/LaunchAgents'), { recursive: true });
let old;
try { old = await readFile(path, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (old && old !== text) throw new Error('Existing draft service configuration differs; preserved for review.');
await writeFile(path, text, { mode: 0o600 }); await chmod(path, 0o600);
const domain = `gui/${process.getuid()}`;
let installed = false;
try { await run('/bin/launchctl', ['print', `${domain}/${label}`]); installed = true; } catch {}
if (!installed) await run('/bin/launchctl', ['bootstrap', domain, path]);
console.log('本地轮抽采集服务已启用；每两秒采集，Git 新数据按批备份。');
