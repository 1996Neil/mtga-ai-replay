import { spawn } from 'node:child_process';

/** Two bounded, guard-local Git readers. Nothing (including an open pack handle)
 * survives a complete safety guard. Every requested object is read again. */
export function createGitBatch({ cwd, env = {}, gitArgs = [], onSpawn } = {}) {
  const readers = new Map(); let closed = false;
  function reader(mode) {
    if (readers.has(mode)) return readers.get(mode);
    const child = spawn('git',[...gitArgs,'cat-file',mode],{cwd,env:{...process.env,...env},stdio:['pipe','pipe','ignore']});
    onSpawn?.();
    child.stdin.on('error',()=>{});
    const iterator=child.stdout[Symbol.asyncIterator]();let buffer=Buffer.alloc(0),offset=0,failure;
    child.on('error',error=>{failure=error;});
    const ended=new Promise(resolve=>child.once('close',resolve));
    async function fill(){if(offset<buffer.length)return;if(failure)throw failure;const next=await iterator.next();if(next.done)throw Error('Git batch ended early');buffer=next.value;offset=0;}
    async function bytes(count){const chunks=[];while(count){await fill();const size=Math.min(count,buffer.length-offset);chunks.push(buffer.subarray(offset,offset+size));offset+=size;count-=size;}return Buffer.concat(chunks);}
    async function line(){const chunks=[];let size=0;while(true){await fill();const end=buffer.indexOf(10,offset);const length=(end<0?buffer.length:end+1)-offset;size+=length;if(size>4096)throw Error('Invalid Git header');chunks.push(buffer.subarray(offset,offset+length));offset+=length;if(end>=0)return Buffer.concat(chunks);}}
    let queue=Promise.resolve();
    function run(input){const task=queue.then(async()=>{
      if(closed)throw Error('Closed Git batch');const hashes=Buffer.from(input??'').toString().trim().split('\n').filter(Boolean);
      if(hashes.some(hash=>!(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).test(hash)))throw Error('Invalid Git batch input');
      if(!hashes.length)return Buffer.alloc(0);const timeout=setTimeout(()=>child.kill('SIGTERM'),30000);
      try {
        // Read while writing: otherwise full stdin/stdout pipes can deadlock.
        const written = new Promise((resolve,reject)=>child.stdin.write(input,error=>error?reject(error):resolve()));
        written.catch(()=>{});
        const chunks=[];let size=0;
        for(const hash of hashes){const header=await line(),match=header.toString('ascii').match(/^([a-f0-9]{40}(?:[a-f0-9]{24})?) (blob|commit|tree) ([0-9]+)\n$/);
          if(!match||match[1]!==hash)throw Error('Invalid Git batch response');chunks.push(header);size+=header.length;
          if(mode==='--batch'){const count=Number(match[3]);if(!Number.isSafeInteger(count)||count<0||size+count+1>512*1024*1024)throw Error('Oversized Git batch');const content=await bytes(count+1);if(content[count]!==10)throw Error('Invalid Git object framing');chunks.push(content);size+=content.length;}
        }
        await written;
        if(offset !== buffer.length)throw Error('Unexpected Git batch bytes');
        return Buffer.concat(chunks,size);
      } catch(error){failure=error;child.kill('SIGKILL');throw error;} finally{clearTimeout(timeout);}
    });queue=task.catch(()=>{});return task;}
    const value={run,close:async()=>{child.stdin.end();const shutdown=setTimeout(()=>child.kill('SIGKILL'),1000);try{
      // Bytes may arrive after run() checked its current buffer. Drain through
      // EOF before accepting the guard, including late trailing output.
      let unexpected=offset!==buffer.length;
      for await(const chunk of iterator)if(chunk.length)unexpected=true;
      const code=await ended;if(code!==0||unexpected||failure)throw Error('Git batch process failed');
    }finally{clearTimeout(shutdown);}}};readers.set(mode,value);return value;
  }
  return {run:async(args,{input}={})=>{if(args[0]!=='cat-file'||!['--batch','--batch-check'].includes(args[1]))throw Error('Unsupported Git batch');return reader(args[1]).run(input);},
    close:async()=>{closed=true;await Promise.all([...readers.values()].map(value=>value.close()));}};
}
