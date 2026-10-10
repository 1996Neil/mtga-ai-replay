import { parentPort } from 'node:worker_threads';
import { validateBundleFiles } from './sync-security.mjs';
import { buildCoachBundle } from './coach-bundle.mjs';
parentPort.on('message', async ({id,operation,input}) => {
  try {
    let value;
    if(operation==='bundle')value=await buildCoachBundle(input.replay,input.options);
    else if(operation==='validate')value=validateBundleFiles(new Map([[input.path,input.content]]));
    else throw Error('Unsupported operation');
    parentPort.postMessage({id,value});
  } catch(error) { parentPort.postMessage({id,error:true,security:error.code==='MTGA_SYNC_SECURITY'}); }
});
