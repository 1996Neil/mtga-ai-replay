import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForOwnedServiceExit } from '../tools/replay2-launcher/launcher-exit.mjs';
const service={pid:43210,started:'synthetic-time'};
test('owned shutdown tolerates the health/ps exit race and requires a subsequent absent port',async()=>{
 let calls=0;await waitForOwnedServiceExit({service,timeoutMs:1000,probe:async()=>{calls++;if(calls===1)throw Object.assign(Error('gone between health and ps'),{code:'REPLAY_PROCESS_IDENTITY_UNAVAILABLE'});return calls===2?service:null;}});assert.equal(calls,3);
});
test('persistent uncertainty times out without reporting successful exit',async()=>{
 await assert.rejects(waitForOwnedServiceExit({service,timeoutMs:0,probe:async()=>{throw Object.assign(Error('unverified'),{code:'REPLAY_PROCESS_IDENTITY_UNAVAILABLE'});}}),/未强制终止/);
});
test('another PID, reused PID/start time, and unrelated errors remain rejected',async()=>{
 for(const next of [{...service,pid:43211},{...service,started:'another-time'}])await assert.rejects(waitForOwnedServiceExit({service,timeoutMs:1000,probe:async()=>next}),/身份改变/);
 const foreign=Object.assign(Error('unrelated guard failure'),{code:'OTHER_GUARD'});await assert.rejects(waitForOwnedServiceExit({service,timeoutMs:1000,probe:async()=>{throw foreign;}}),error=>error===foreign);
});
