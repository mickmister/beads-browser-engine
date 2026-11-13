import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockS3 } from './support/s3.mjs';
import { mkdir,writeFile,rm,readFile } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { configuration,publish } from '../scripts/publish.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(){
 const directory=`build/publish-test-${randomUUID()}`;await mkdir(directory,{recursive:true});
 const contents={'engine.wasm':Buffer.from('wasm test bytes'),'wasm_exec.js':Buffer.from('runtime'),'worker.js':Buffer.from('worker'),'client.js':Buffer.from('client'),'client.d.ts':Buffer.from('types'),'LICENSE':Buffer.from('license'),'licenses.json':Buffer.from('[]')};
 contents['engine.wasm.gz']=gzipSync(contents['engine.wasm']);
 const files=[];for(const [path,bytes]of Object.entries(contents)){await writeFile(`${directory}/${path}`,bytes);files.push({path,size:bytes.length,sha256:sha(bytes)});}
 await writeFile(`${directory}/manifest.json`,JSON.stringify({schemaVersion:1,apiVersion:1,target:'js/wasm',readOnly:true,sourceCommit:'1'.repeat(40),files}));
 const service=await mockS3();
 return{directory,...service,env:{...service.env,ENGINE_EXPECTED_SHA:'1'.repeat(40)},async close(){await service.close();await rm(directory,{recursive:true,force:true});}};
}
test('publishes with object-only permissions, verifies compressed/public bytes and CORS, and replays without overwrites',async()=>{
 const f=await fixture();try{
  f.race();const receipt=await publish({env:f.env,directory:f.directory,receiptPath:f.directory+'/receipt.json'});
  assert.equal(receipt.verifiedFiles,9);assert.equal(receipt.publicDeliveryVerified,true);
  assert.deepEqual(f.bucketRequests,[],'Publisher must not read or write bucket configuration');
  assert.equal(f.puts.at(-1),'prefix/commits/'+ '1'.repeat(40)+'/manifest.json');
  const wasm=f.objects.get('prefix/commits/'+ '1'.repeat(40)+'/engine.wasm');assert.equal(wasm.headers['content-encoding'],'gzip');assert.equal(wasm.headers['content-type'],'application/wasm');
  const count=f.puts.length;await publish({env:f.env,directory:f.directory,receiptPath:f.directory+'/receipt.json'});assert.equal(f.puts.length,count);assert.deepEqual(f.bucketRequests,[]);
  assert.ok(!(await readFile(f.directory+'/receipt.json','utf8')).includes('test-secret'));
  const worker=f.objects.get('prefix/commits/'+ '1'.repeat(40)+'/worker.js');worker.bytes=Buffer.from('wrong');
  await assert.rejects(publish({env:f.env,directory:f.directory,receiptPath:f.directory+'/receipt.json'}),/Immutable release collision/);
 }finally{await f.close();}
});
test('fails on missing secrets, local corruption, wrong commit, or missing public CORS rather than reporting publication success',async()=>{
 assert.throws(()=>configuration({}),/Missing secret S3_ENDPOINT/);
 const f=await fixture();try{
  await assert.rejects(publish({env:{...f.env,ENGINE_EXPECTED_SHA:'2'.repeat(40)},directory:f.directory}),/source commit/);
  await writeFile(f.directory+'/worker.js','tampered');await assert.rejects(publish({env:f.env,directory:f.directory}),/Local release integrity/);assert.equal(f.puts.length,0);
 }finally{await f.close();}
 const cors=await fixture();try{cors.badCors();await assert.rejects(publish({env:cors.env,directory:cors.directory,receiptPath:cors.directory+'/receipt.json'}),/CORS verification failed/);}finally{await cors.close();}
});
