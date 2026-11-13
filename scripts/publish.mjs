import { AwsClient } from 'aws4fetch';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const required = ['S3_ENDPOINT','S3_REGION','S3_BUCKET','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY','S3_KEY_PREFIX','S3_PUBLIC_BASE_URL','S3_CORS_ALLOWED_ORIGINS'];
export function configuration(env) {
  for(const name of required)if(!env[name]?.trim())throw new Error(`Missing secret ${name}`);
  function url(name){try{const value=new URL(env[name]);if(value.username||value.password||value.search||value.hash||value.protocol!=='https:'&&!(value.protocol==='http:'&&['127.0.0.1','localhost'].includes(value.hostname)))throw new Error();return value;}catch{throw new Error(`Invalid secret ${name}`);}}
  const endpoint=url('S3_ENDPOINT'),publicBase=url('S3_PUBLIC_BASE_URL');
  if(endpoint.pathname!=='/')throw new Error('S3_ENDPOINT must be an account/service root');
  if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.S3_BUCKET))throw new Error('Invalid secret S3_BUCKET');
  const prefix=env.S3_KEY_PREFIX.replace(/\/+$/,'');
  if(!prefix||prefix.split('/').some(part=>!part||part==='.'||part==='..')||/[\\\0\r\n]/.test(prefix))throw new Error('Invalid secret S3_KEY_PREFIX');
  let origins;try{origins=JSON.parse(env.S3_CORS_ALLOWED_ORIGINS);}catch{throw new Error('S3_CORS_ALLOWED_ORIGINS must be a JSON array');}
  if(!Array.isArray(origins)||!origins.length||origins.some(origin=>typeof origin!=='string'||origin!=='*'&&!/^https?:\/\/[^/]+$/.test(origin)))throw new Error('Invalid secret S3_CORS_ALLOWED_ORIGINS');
  if(!publicBase.pathname.endsWith('/'))publicBase.pathname+='/';
  return {endpoint,publicBase,bucket:env.S3_BUCKET,prefix,origins,region:env.S3_REGION,accessKeyId:env.S3_ACCESS_KEY_ID,secretAccessKey:env.S3_SECRET_ACCESS_KEY,sessionToken:env.S3_SESSION_TOKEN||undefined};
}
const contentType = path => path.endsWith('.wasm')?'application/wasm':path.endsWith('.js')?'application/javascript; charset=utf-8':path.endsWith('.json')?'application/json':path.endsWith('.gz')?'application/gzip':'text/plain; charset=utf-8';
const safePath = path => typeof path==='string'&&!/[\\\0\r\n]/.test(path)&&path.split('/').every(part=>part&&part!=='.'&&part!=='..');
async function bounded(response,max) {
  if(!response.body)return Buffer.alloc(0);
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{while(true){const result=await reader.read();if(result.done)break;size+=result.value.length;if(size>max)throw new Error('Remote object exceeds declared bound');chunks.push(result.value);}}finally{await reader.cancel();reader.releaseLock();}
  return Buffer.concat(chunks,size);
}
export async function publish({env=process.env,directory=resolve('dist'),fetcher=fetch,receiptPath='build/publication.json'}={}) {
  const config=configuration(env),manifestBytes=await readFile(join(directory,'manifest.json'));
  const manifest=JSON.parse(manifestBytes);
  if(manifest.schemaVersion!==1||manifest.apiVersion!==1||manifest.target!=='js/wasm'||manifest.readOnly!==true||!/^[0-9a-f]{40}$/.test(manifest.sourceCommit)||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>1000)throw new Error('Invalid release manifest');
  if(env.ENGINE_EXPECTED_SHA&&env.ENGINE_EXPECTED_SHA!==manifest.sourceCommit)throw new Error('Release source commit does not match workflow commit');
  const names=new Set();
  for(const file of manifest.files){if(!safePath(file.path)||file.path==='manifest.json'||names.has(file.path)||!Number.isSafeInteger(file.size)||file.size<0||file.size>128<<20||!/^[0-9a-f]{64}$/.test(file.sha256))throw new Error('Invalid release file manifest');names.add(file.path);const bytes=await readFile(join(directory,file.path));if(bytes.length!==file.size||hash(bytes)!==file.sha256)throw new Error('Local release integrity failure');}
  for(const name of ['engine.wasm','engine.wasm.gz','wasm_exec.js','worker.js','client.js','client.d.ts','LICENSE','licenses.json'])if(!names.has(name))throw new Error(`Missing release asset ${name}`);
  const client=new AwsClient({accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey,sessionToken:config.sessionToken,service:'s3',region:config.region,retries:0});
  const objectURL=key=>new URL(`/${encodeURIComponent(config.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`,config.endpoint).href;
  async function remote(input,init,label){
    try{return await fetcher(input,init);}catch(error){
      const code=error?.cause?.code;
      throw new Error(`${label} network request failed${typeof code==='string'&&/^[A-Z0-9_]+$/.test(code)?` (${code})`:''}`);
    }
  }
  async function signed(url,init={}){const request=await client.sign(url,init);return remote(request,undefined,'S3 API');}
  async function request(url,init={}) {
    for(let attempt=0;;attempt++){
      const response=await signed(url,init);
      if(![429,500,502,503,504].includes(response.status)||attempt===4)return response;
      const retry=response.headers.get('retry-after');const parsed=retry?Number(retry):NaN;
      const wait=Number.isFinite(parsed)?parsed*1000:retry?Date.parse(retry)-Date.now():1000*2**attempt;
      await response.body?.cancel();
      if(wait>60000)throw new Error('S3 requested a long retry delay; rerun publication later');
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,wait)));
    }
  }
  // Bucket configuration is operator-managed; credentials only need object access.
  const release=`commits/${manifest.sourceCommit}`;
  async function upload(file,bytes,encoding) {
    const url=objectURL(`${config.prefix}/${release}/${file.path}`);
    const existing=await request(url);
    if(existing.ok){if(hash(await bounded(existing,file.size))!==file.sha256)throw new Error('Immutable release collision');}
    else if(existing.status===404){
      await existing.body?.cancel();
      const response=await request(url,{method:'PUT',body:bytes,headers:{'if-none-match':'*','content-type':contentType(file.path),'cache-control':'public, max-age=31536000, immutable',...(encoding?{'content-encoding':encoding}:{}),'x-amz-meta-sha256':file.sha256}});
      if(!response.ok&&response.status!==412)throw new Error(`Upload failed (${response.status})`);await response.body?.cancel();
    }else throw new Error(`Unable to inspect release object (${existing.status})`);
    const readback=await request(url);
    if(!readback.ok||hash(await bounded(readback,file.size))!==file.sha256)throw new Error('Signed upload readback failed');
  }
  for(const file of manifest.files){const bytes=await readFile(join(directory,file.path));await upload(file,file.path==='engine.wasm'?await readFile(join(directory,'engine.wasm.gz')):bytes,file.path==='engine.wasm'?'gzip':undefined);}
  // Immutable completion manifest is last: a partial upload is not a release.
  await upload({path:'manifest.json',size:manifestBytes.length,sha256:hash(manifestBytes)},manifestBytes);
  const origin=config.origins[0]==='*'?'https://beads-browser-engine.invalid':config.origins[0];
  const base=new URL(release+'/',config.publicBase);
  for(const file of [...manifest.files,{path:'manifest.json',size:manifestBytes.length,sha256:hash(manifestBytes)}]){
    let response;
    for(let attempt=0;attempt<6;attempt++){
      response=await remote(new URL(file.path,base),{headers:{origin}},'Public delivery');
      if(response.ok)break;
      const status=response.status;await response.body?.cancel();if(![404,429,500,502,503,504].includes(status)||attempt===5)throw new Error(`Public delivery unavailable (${status})`);
      const retry=Number(response.headers.get('retry-after'));await new Promise(resolve=>setTimeout(resolve,Number.isFinite(retry)&&retry>0?Math.min(retry*1000,60000):1000*2**attempt));
    }
    if(!response?.ok||![origin,'*'].includes(response.headers.get('access-control-allow-origin')))throw new Error('Public delivery CORS verification failed');
    if(hash(await bounded(response,file.size))!==file.sha256)throw new Error('Public delivery integrity failure');
    if((response.headers.get('content-type')??'').split(';')[0]!==contentType(file.path).split(';')[0])throw new Error('Public delivery MIME verification failed');
    if(!response.headers.get('cache-control')?.includes('immutable'))throw new Error('Public delivery cache verification failed');
    if(file.path==='engine.wasm'&&response.headers.get('content-encoding')!=='gzip')throw new Error('Public delivery compression verification failed');
  }
  const receipt={schemaVersion:1,sourceCommit:manifest.sourceCommit,releasePath:release,manifestSha256:hash(manifestBytes),verifiedFiles:manifest.files.length+1,uploadedReadbackVerified:true,publicDeliveryVerified:true,corsVerified:true};
  await mkdir(resolve(receiptPath,'..'),{recursive:true});await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n');
  return receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(await publish()));}catch(error){console.error(error instanceof Error?error.message:'Publication failed');process.exitCode=1;}}
