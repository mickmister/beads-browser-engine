import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
const cases=JSON.parse(await readFile('build/browser-fixture/cases.json','utf8'));
const release=JSON.parse(await readFile('dist/manifest.json','utf8'));
async function prepare(page){
 await page.goto('/');
 await page.evaluate(async()=>{
  const {assetBaseURL}=await(await fetch('/meta.json')).json();
  const {BeadsBrowserEngine}=await import(assetBaseURL+'client.js');
  window.engine=await BeadsBrowserEngine.create({baseURL:assetBaseURL,timeoutMs:150000});
  const snapshot=await(await fetch('/fixture/snapshot.json')).json();
  for(const file of [...snapshot.files,snapshot.manifest])file.url=new URL('/fixture/'+file.url,location.origin).href;
  window.snapshot=snapshot;
 });
}
test('same wasm32 artifact matches native Beads for complete records, filters, readiness, blockers, and rejects mutations',async({page},testInfo)=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 if(process.env.ENGINE_EXPECTED_SHA)expect(release.sourceCommit).toBe(process.env.ENGINE_EXPECTED_SHA);
 await prepare(page);
 const started=Date.now();const metadata=await page.evaluate(()=>window.engine.open(window.snapshot));
 const snapshot=JSON.parse(await readFile('build/browser-fixture/snapshot.json','utf8'));expect(metadata.commit).toBe(snapshot.commit);
 for(const value of cases){const actual=await page.evaluate(request=>window.engine.query(request),value.request);expect(actual,value.name).toEqual(value.expected);}
 const rejected=await page.evaluate(async()=>{
  const result=[];
  for(const request of [{operation:'add-label'},{operation:'ready',workFilter:{SortPolicy:'invalid'}},{operation:'list',approved:true}]){
   try{await window.engine.query(request);result.push(false);}catch{result.push(true);}
  }
  return result;
 });expect(rejected).toEqual([true,true,true]);
 expect(await page.evaluate(request=>window.engine.query(request),cases[0].request)).toEqual(cases[0].expected);
 const state=await page.evaluate(()=>window.engine.state());expect(state.putRejected).toBe(true);expect(state.commitRejected).toBe(true);expect(state.sealed).toBe(true);
 await testInfo.attach('engine-evidence',{body:JSON.stringify({browser:testInfo.project.name,host:process.arch,sourceCommit:release.sourceCommit,wasm:release.files.find(file=>file.path==='engine.wasm'),fixtureCommit:snapshot.commit,cases:cases.length,startupAndQueriesMs:Date.now()-started,state},null,2),contentType:'application/json'});
 await page.evaluate(()=>window.engine.dispose());expect(errors).toEqual([]);
});
test('rejects corrupt snapshot identities and cancellation destroys the isolated runtime',async({page})=>{
 await prepare(page);
 const failure=await page.evaluate(async()=>{const snapshot=structuredClone(window.snapshot);snapshot.files[0].sha256='0'.repeat(64);try{await window.engine.open(snapshot);return '';}catch(error){return error.message;}});
 expect(failure).toContain('integrity');
 await prepare(page);
 expect(await page.evaluate(async()=>{const controller=new AbortController();const pending=window.engine.open(window.snapshot,controller.signal);controller.abort();try{await pending;return false;}catch{try{await window.engine.state();return false;}catch{return true;}}})).toBe(true);
});
