import { execFileSync } from 'node:child_process';
import { accessSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('MTGA Replay.app requires macOS.');
const project = fileURLToPath(new URL('../../', import.meta.url));
const source = fileURLToPath(new URL('./Launcher.swift', import.meta.url));
const node = realpathSync(process.execPath);
const cli = join(project, 'bin/mtga-gpt-replay.mjs');
accessSync(node, constants.X_OK); accessSync(cli, constants.R_OK);
const bundleId = 'local.mtga.replay.launcher';
const destination = resolve(process.argv[2] ?? '/Applications/MTGA Replay.app');
if (!destination.endsWith('/MTGA Replay.app')) throw new Error('Destination must be a directory named MTGA Replay.app.');
const backupRoot = join(homedir(), 'Library/Application Support/MTGA Replay/launcher-backups');
const assets = fileURLToPath(new URL('./assets/', import.meta.url));
const png = join(assets, 'MTGAReplay.png'), icns = join(assets, 'MTGAReplay.icns');
const iconSource = existsSync(png) ? png : existsSync(icns) ? icns : null;
if (!iconSource) throw new Error('Selected App icon missing. Add tools/macos-launcher/assets/MTGAReplay.png (square PNG, ideally 1024×1024) or MTGAReplay.icns before installing.');
accessSync(iconSource, constants.R_OK);

// Only native size/format packaging: preserve the selected artwork unchanged.
// Prepare before changing the existing build or installed application.
function packageIcon() {
  const temporary = mkdtempSync(join(tmpdir(), 'mtga-replay-icon-'));
  const iconset = join(temporary, 'MTGAReplay.iconset');
  const packed = join(temporary, 'MTGAReplay.icns');
  try {
    if (iconSource === icns) {
      // Validate an existing ICNS with the same native codec before copying it.
      execFileSync('/usr/bin/iconutil', ['-c', 'iconset', '-o', iconset, iconSource]);
      return readFileSync(iconSource);
    }
    const details = execFileSync('/usr/bin/sips', ['-g', 'format', '-g', 'pixelWidth', '-g', 'pixelHeight', iconSource], { encoding: 'utf8' });
    const format = details.match(/^\s*format:\s*(\S+)/m)?.[1];
    const width = Number(details.match(/^\s*pixelWidth:\s*(\d+)/m)?.[1]);
    const height = Number(details.match(/^\s*pixelHeight:\s*(\d+)/m)?.[1]);
    if (format !== 'png' || !width || width !== height) throw new Error('MTGAReplay.png must be a valid square PNG; the installer does not crop or redesign artwork.');
    mkdirSync(iconset);
    for (const points of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
      const pixels = String(points * scale), name = `icon_${points}x${points}${scale === 2 ? '@2x' : ''}.png`;
      execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-z', pixels, pixels, iconSource, '--out', join(iconset, name)]);
    }
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', '-o', packed, iconset]);
    return readFileSync(packed);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
const iconBytes = packageIcon();
const buildRoot = mkdtempSync(join(tmpdir(), 'mtga-replay-launcher-'));
const output = join(buildRoot, 'MTGA Replay.app');
const writePlist = (path, value) => {
  writeFileSync(path, JSON.stringify(value));
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', path]);
};
let incoming;
let ownsIncoming = false;
let previous;
try {
  mkdirSync(join(output, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(output, 'Contents/Resources'), { recursive: true });
  writePlist(join(output, 'Contents/Info.plist'), {
    CFBundleIdentifier: bundleId, CFBundleName: 'MTGA Replay', CFBundleDisplayName: 'MTGA Replay',
    CFBundleExecutable: 'MTGAReplayLauncher', CFBundlePackageType: 'APPL', CFBundleIconFile: 'MTGAReplay.icns',
    CFBundleVersion: '1', CFBundleShortVersionString: '1.0',
    LSMinimumSystemVersion: '12.0', LSUIElement: true, NSHighResolutionCapable: true,
    NSDocumentsFolderUsageDescription: '读取现有 MTGA Replay 项目以运行最新对局回放命令。',
  });
  writeFileSync(join(output, 'Contents/Resources/MTGAReplay.icns'), iconBytes);
  writePlist(join(output, 'Contents/Resources/LauncherConfig.plist'), {
    NodePath: node, CLIPath: cli, ProjectPath: project,
    SearchPath: [...new Set([dirname(node), join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':'),
  });
  execFileSync('/usr/bin/xcrun', ['swiftc', source, '-O', '-framework', 'AppKit', '-o', join(output, 'Contents/MacOS/MTGAReplayLauncher')], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', output], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', output]);

  // Preserve an existing unrelated application, and keep the preceding managed install as a backup.
  if (existsSync(destination)) {
    const existing = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(destination, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
    if (existing !== bundleId) throw new Error('An unrelated MTGA Replay.app already exists; it was not changed.');
  }
  mkdirSync(dirname(destination), { recursive: true });
  incoming = `${destination}.installing-${process.pid}`;
  if (existsSync(incoming)) throw new Error('An install staging directory already exists; it was not changed.');
  ownsIncoming = true;
  cpSync(output, incoming, { recursive: true, errorOnExist: true, force: false });
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', incoming]);
  if (existsSync(destination)) {
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    const backup = join(backupRoot, `MTGA Replay-${Date.now()}.zip`);
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', destination, backup]);
    execFileSync('/usr/bin/unzip', ['-t', backup]);
    previous = join(buildRoot, 'previous-install');
    renameSync(destination, previous);
  }
  renameSync(incoming, destination);
  ownsIncoming = false;
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', destination]);
  console.log(`Installed: ${destination}`);
  console.log('Double-click MTGA Replay. It runs the existing latest command without Terminal.');
} finally {
  if (previous && existsSync(previous) && !existsSync(destination)) renameSync(previous, destination);
  if (ownsIncoming) rmSync(incoming, { recursive: true, force: true });
  rmSync(buildRoot, { recursive: true, force: true });
}
