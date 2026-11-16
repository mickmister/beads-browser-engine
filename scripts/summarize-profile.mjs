import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const directory = process.argv[2];
const native = JSON.parse(await readFile(join(directory, 'profile.json')));
const identity = JSON.parse(await readFile(join(directory, 'identity.json')));
const progress = JSON.parse(await readFile(join(directory, 'progress.json')));
const quantiles = values => { const sorted = [...values].sort((a,b)=>a-b); return { n: sorted.length, min: sorted[0], median: sorted.length%2 ? sorted[(sorted.length-1)/2] : (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2, p90: sorted[Math.ceil(sorted.length*.9)-1], max: sorted.at(-1) }; };
const describe = samples => Object.fromEntries(['decodeMs','openMs','queriesMs','totalMs','allocatedBytes','decodedBytes','chunks','heapAllocBytes'].flatMap(key => { const values = samples.map(sample => sample[key] ?? sample.state?.[key]).filter(value=>value!==undefined); return values.length ? [[key,quantiles(values)]] : []; }));
const report = { identity, doltCommit: progress.doltCommit, issueRoot: progress.issueRoot, parity: native.parity, resultCounts: native.resultCounts, arms: native.arms, controlAA: describe(native.samples.slice(0,5)), nativePaired: Object.fromEntries(native.arms.map(({name})=>[name,describe(native.samples.slice(5).filter(sample=>sample.arm===name))])) };
try { const browser = JSON.parse(await readFile(join(directory,'browser-profile.json'))); report.browserScope=browser.scope; report.browserSource=browser.sourceCommit; report.browserAA=describe(browser.samples.filter(sample=>sample.phase==='control-aa')); report.browserPaired=Object.fromEntries(['original-full','current-head'].map(arm=>[arm,describe(browser.samples.filter(sample=>sample.phase==='paired'&&sample.arm===arm))]));
  const paired = browser.samples.filter(sample=>sample.phase==='paired'); const logRatios=[];
  for (let i=0;i<paired.length;i+=2) { const pair=paired.slice(i,i+2);assert.equal(pair.length,2);const full=pair.find(sample=>sample.arm==='original-full'),head=pair.find(sample=>sample.arm==='current-head');assert.ok(full&&head);logRatios.push(Math.log(full.totalMs/head.totalMs)); }
  if (logRatios.length) {
    let seed=123456789;const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296;};
    const boot=[];for(let trial=0;trial<10000;trial++){let sum=0;for(let j=0;j<logRatios.length;j++)sum+=logRatios[Math.floor(random()*logRatios.length)];boot.push(Math.exp(sum/logRatios.length));}boot.sort((a,b)=>a-b);
    report.browserPairedEffect={pairs:logRatios.length,allPairsFaster:logRatios.every(value=>value>0),geometricMeanSpeedup:Math.exp(logRatios.reduce((a,b)=>a+b,0)/logRatios.length),bootstrap95PercentCI:[boot[250],boot[9749]],scope:'Paired local samples only; does not estimate between-device or production-network variation.'};
  }
  if (process.argv[3]) {
    const response = await fetch(new URL('manifest.json', process.argv[3])); assert.equal(response.ok, true);
    const bytes = Buffer.from(await response.arrayBuffer()), hash = data => createHash('sha256').update(data).digest('hex');
    assert.equal(hash(bytes), process.argv[4], 'Published release manifest pin');
    const release = JSON.parse(bytes); const matched = [];
    for (const name of ['client.js','worker.js','wasm_exec.js','engine.wasm']) { const local = await readFile(join('dist',name)), entry = release.files.find(file=>file.path===name); assert.equal(local.length,entry.size);assert.equal(hash(local),entry.sha256);matched.push(name); }
    assert.equal(browser.wasm.sha256, release.files.find(file=>file.path==='engine.wasm').sha256);
    report.verifiedRuntime={publishedSource:release.sourceCommit,manifestSha256:hash(bytes),matchedAssets:matched,localManifestSource:browser.sourceCommit,note:'Local manifest source metadata predates commit; all executable asset bytes match the pinned published release.'};
  }
} catch(error) { if(error.code!=='ENOENT')throw error; }
await writeFile(join(directory,'summary.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify(report,null,2));
