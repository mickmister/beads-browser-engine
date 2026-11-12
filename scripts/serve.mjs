import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve,sep } from 'node:path';
const port=Number(process.env.ENGINE_TEST_PORT??8761);
async function handler(req,res){
 try{
  const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  if(path==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><title>Beads browser engine integration</title>');return;}
  if(path==='/meta.json'){res.setHeader('content-type','application/json');res.end(JSON.stringify({assetBaseURL:`http://127.0.0.1:${port+1}/dist/`}));return;}
  let root,relative;
  if(path.startsWith('/dist/')){root=resolve('dist');relative=path.slice(6);}
  else if(path.startsWith('/fixture/')){root=resolve('build/browser-fixture');relative=path.slice(9);}
  else{res.statusCode=404;res.end();return;}
  const file=resolve(root,relative);if(!file.startsWith(root+sep))throw new Error('Invalid test path');
  const bytes=await readFile(file);
  res.setHeader('access-control-allow-origin','*');
  res.setHeader('content-type',file.endsWith('.wasm')?'application/wasm':file.endsWith('.js')?'application/javascript':file.endsWith('.json')?'application/json':'application/octet-stream');
  res.end(bytes);
 }catch{res.statusCode=404;res.end();}
}
const servers=[createServer(handler),createServer(handler)];
await Promise.all(servers.map((server,index)=>new Promise(resolve=>server.listen(port+index,'127.0.0.1',resolve))));
console.log('Engine integration server ready');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{for(const server of servers){server.closeAllConnections();server.close();}process.exit(0);});
