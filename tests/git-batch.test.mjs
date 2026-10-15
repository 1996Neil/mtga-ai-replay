// Independent synthetic protocol regression. Never execute a real child/network.
// Run from any cwd: node /absolute/path/to/evidence/git-batch-nonzero.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createHash } from 'node:crypto';

const deny = () => { throw Error('Independent review forbids external execution'); };
for (const name of ['spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) child[name] = deny;
globalThis.fetch = async () => { throw Error('Independent review forbids network requests'); };

const content = Buffer.from('{}');
const hash = createHash('sha1').update('blob 2\0').update(content).digest('hex');
let exitCode = 0, mockedSpawns = 0, late = false;
child.spawn = (command, args) => {
  assert.equal(command, 'git');
  assert.deepEqual(args, ['cat-file', '--batch']);
  mockedSpawns++;
  const process = new EventEmitter();
  process.stdout = new PassThrough();
  process.kill = () => true;
  let completed = false;
  process.stdin = new Writable({
    write(input, encoding, done) {
      assert.equal(String(input), hash + '\n');
      assert.equal(completed, false);
      completed = true;
      process.stdout.write(Buffer.concat([Buffer.from(`${hash} blob 2\n`), content, Buffer.from('\n')]));
      done();
      setImmediate(() => {process.stdout.end(late?Buffer.from('unexpected late bytes'):undefined);process.emit('close',exitCode,null);});
    },
  });
  return process;
};
syncBuiltinESMExports();
const { createGitBatch } = await import('../src/git-batch.mjs');

test('complete synthetic object with exit 0 is accepted and drained', async () => {
  exitCode = 0;
  const batch = createGitBatch({ cwd: '/synthetic-only' });
  const output = await batch.run(['cat-file', '--batch'], { input: Buffer.from(hash + '\n') });
  assert.deepEqual(output, Buffer.concat([Buffer.from(`${hash} blob 2\n`), content, Buffer.from('\n')]));
  await batch.close();
});

test('complete synthetic object with nonzero exit cannot pass run plus close', async () => {
  exitCode = 17;
  const batch = createGitBatch({ cwd: '/synthetic-only' });
  await assert.rejects(async () => {
    await batch.run(['cat-file', '--batch'], { input: Buffer.from(hash + '\n') });
    await batch.close();
  });
  assert.equal(mockedSpawns, 2);
});

 test('late trailing stdout cannot pass a completed object plus clean process exit',async()=>{
 exitCode=0;late=true;const batch=createGitBatch({cwd:'/synthetic-only'});
 await assert.rejects(async()=>{await batch.run(['cat-file','--batch'],{input:Buffer.from(hash+'\n')});await batch.close();});
 });
