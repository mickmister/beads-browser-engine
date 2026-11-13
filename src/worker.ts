// Classic dedicated Worker: no module imports, DOM access, credentials or native server.
(() => {
  type Reference = { url:string;size:number;sha256:string };
  const scope = globalThis as unknown as {
    Go: new () => { importObject: WebAssembly.Imports; run(instance:WebAssembly.Instance):Promise<void> };
    snapshotLoad(bytes:Uint8Array):string; snapshotOpen(manifest:string):string;
    snapshotState():string; beadsOperation(request:string):string;
  };
  let state: 'empty'|'loading'|'ready'|'failed' = 'empty';
  let queue = Promise.resolve();
  async function verified(file:Reference,max:number) {
    if (!file || typeof file.url !== 'string' || !Number.isSafeInteger(file.size) || file.size<=0 || file.size>max || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid file identity or bound');
    const response = await fetch(file.url,{credentials:'omit'});
    if(!response.ok || !response.body) throw new Error('Snapshot/asset fetch failed');
    const reader=response.body.getReader(),chunks:Uint8Array[]=[]; let size=0;
    try { while(true) { const result=await reader.read(); if(result.done)break; size+=result.value.length; if(size>file.size)throw new Error('File exceeds declared bound'); chunks.push(result.value); } }
    finally { await reader.cancel(); reader.releaseLock(); }
    const bytes=new Uint8Array(size); let at=0; for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
    const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
    if(size!==file.size || sha!==file.sha256)throw new Error('File integrity mismatch');
    return bytes;
  }
  const result = (json:string) => { const value=JSON.parse(json); if(value.error)throw new Error(value.error); return value; };
  async function handle(method:string,value:any) {
    if(method==='open') {
      if(state!=='empty')throw new Error('Invalid immutable snapshot state');
      state='loading';
      try {
        const snapshot=value.snapshot;
        if(snapshot?.apiVersion!==1 || snapshot.commit!==undefined&&!/^[0-9a-v]{32}$/.test(snapshot.commit) || !Array.isArray(snapshot.files) || !snapshot.files.length || snapshot.files.length>512)throw new Error('Invalid snapshot descriptor');
        let total=0;const urls=new Set<string>();
        for(const file of snapshot.files){if(!Number.isSafeInteger(file.size)||file.size<=0||file.size>64<<20||urls.has(file.url))throw new Error('Invalid snapshot file');total+=file.size;urls.add(file.url);}
        if(total>64<<20)throw new Error('Encoded snapshot exceeds 64 MiB');
        const runtime=await verified(value.assets.runtime,256<<10), url=URL.createObjectURL(new Blob([runtime],{type:'text/javascript'}));
        try{importScripts(url);}finally{URL.revokeObjectURL(url);}
        const go=new scope.Go();
        const {instance}=await WebAssembly.instantiate(await verified(value.assets.wasm,128<<20),go.importObject);
        void go.run(instance).catch(error=>{state='failed';postMessage({apiVersion:1,id:0,error:String(error)});});
        if(typeof scope.snapshotLoad!=='function')throw new Error('Runtime initialization failed');
        for(const file of snapshot.files)result(scope.snapshotLoad(await verified(file,64<<20)));
        const metadata=result(scope.snapshotOpen(new TextDecoder('utf-8',{fatal:true}).decode(await verified(snapshot.manifest,1<<20))));
        if(snapshot.commit!==undefined&&metadata.commit!==snapshot.commit)throw new Error('Dolt commit identity mismatch');
        state='ready';return metadata;
      }catch(error){state='failed';throw error;}
    }
    if(state!=='ready')throw new Error('Snapshot not ready');
    if(method==='state')return result(scope.snapshotState());
    if(method==='query') {
      if(!value || !['list','ready','blocked'].includes(value.operation))throw new Error('Unsupported read-only operation');
      const input=JSON.stringify(value);if(new TextEncoder().encode(input).length>1<<20)throw new Error('Request exceeds 1 MiB');
      return result(scope.beadsOperation(input));
    }
    throw new Error('Unsupported read-only method');
  }
  onmessage=event=>{
    const message=event.data;
    if(message?.apiVersion!==1 || !Number.isSafeInteger(message.id))return;
    queue=queue.then(async()=>{try{postMessage({apiVersion:1,id:message.id,result:await handle(message.method,message.value)});}catch(error){postMessage({apiVersion:1,id:message.id,error:error instanceof Error?error.message:String(error)});}});
  };
})();
