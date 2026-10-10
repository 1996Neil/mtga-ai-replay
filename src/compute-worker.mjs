import {bundleFiles} from './coach-bundle-files.mjs';
import { parentPort } from 'node:worker_threads';
import { validateBundleFiles } from './sync-security.mjs';
import { buildCoachBundle } from './coach-bundle.mjs';
parentPort.on('message', async ({id,operation,input}) => {
  try {
    let value;
    if(operation==='bundle')value=await buildCoachBundle(input.replay,input.options);
    else if(operation==='validate')value=validateBundleFiles(new Map([[input.path,input.content]]));
    else if(operation==='bundleFiles')value=bundleFiles(input.bundle);
    else if(operation==='validateFiles')value=validateBundleFiles(input.files);
    else throw Error('Unsupported operation');
    parentPort.postMessage({id,value});
  } catch(error) { parentPort.postMessage({id,error:true,security:error.code==='MTGA_SYNC_SECURITY',code:error.code==='SYNC_BUNDLE'?'SYNC_BUNDLE':undefined}); }
});
