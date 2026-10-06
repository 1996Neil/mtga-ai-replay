// Isolated process environment: synthetic config and fixed provider mocks only.
import { mkdir, symlink, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLauncher } from '../../tools/replay2-launcher/launcher.mjs';
const directory=process.env.REPLAY2_STANDBY_FIXTURE_DIR;
const root=join(directory,'project'),port=Number(process.env.REPLAY2_STANDBY_FIXTURE_PORT);
await mkdir(join(root,'bin'),{recursive:true});await mkdir(join(root,'viewer/dist'),{recursive:true});
await symlink(fileURLToPath(new URL('../../bin/mtga-gpt-replay.mjs',import.meta.url)),join(root,'bin/mtga-gpt-replay.mjs'));
await writeFile(join(root,'viewer/dist/index.html'),'Synthetic fixture');
process.env.NODE_OPTIONS=`--import ${fileURLToPath(new URL('./standby-cli-mock.mjs',import.meta.url))}`;
const launcher=createLauncher({projectRoot:root,port,stateDir:join(directory,'launcher'),extraArgs:['--config-dir',directory,'--repo-dir',directory,'--data-dir',join(directory,'data'),'--viewer-dir',join(root,'viewer/dist')],openBrowser:async()=>{throw Error('Browser must not open in this test');}});
try {
  const first=await launcher.start({openPage:false});
  const cold=JSON.parse(await readFile(join(directory,'cold.json'),'utf8'));
  const repeated=await Promise.all(Array.from({length:5},()=>launcher.start({openPage:false})));
  const stopped=await launcher.stop();const afterStop=await launcher.status();
  const reopened=await launcher.start({openPage:false});
  await launcher.stop();
  const final=await launcher.status(),exit=JSON.parse(await readFile(join(directory,'exit.json'),'utf8'));
  await writeFile(join(directory,'launcher-facts.json'),JSON.stringify({first,cold,repeated,stopped,afterStop,reopened,final,exit}),{mode:0o600});
} finally {await launcher.stop().catch(()=>{});}
