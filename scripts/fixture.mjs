import { execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rm, readdir, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer, connect } from 'node:net';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const directory=resolve('build/fixture/db'), output=resolve('build/browser-fixture');
const native=resolve('build/native');
const fixtureEnv={...process.env};delete fixtureEnv.DOLT_CLI_PASSWORD;delete fixtureEnv.DOLT_CLI_USER;
const run=(args,input)=>execFileSync('dolt',args,{cwd:directory,input,encoding:'utf8',maxBuffer:8<<20,env:fixtureEnv});
assert.match(execFileSync('dolt',['version'],{encoding:'utf8'}),/dolt version 2\.3\.1\b/);
await rm(resolve('build/fixture'),{recursive:true,force:true}); await rm(output,{recursive:true,force:true});
await mkdir(directory,{recursive:true}); await mkdir(join(output,'snapshot'),{recursive:true});
run(['init','--name','Browser fixture','--email','fixture@example.invalid']);
// Generate only upstream native schema, not a JSON stand-in for a database.
run(['sql'],execFileSync(native,['--schema'],{encoding:'utf8',maxBuffer:8<<20}));
run(['sql'],`
INSERT INTO issues (id,title,description,design,acceptance_criteria,notes,status,priority,issue_type,created_at,updated_at,metadata) VALUES
('demo-root','Workspace epic','','','','','open',1,'epic','2020-01-01 00:00:00','2020-01-01 00:00:00','{}'),
('demo-ready','Build workspace reader','','','','','open',0,'task','2020-01-02 00:00:00','2020-01-02 00:00:00','{"area":"browser"}'),
('demo-blocked','Publish workspace package','','','','','open',1,'task','2020-01-03 00:00:00','2020-01-03 00:00:00','{}'),
('demo-child','Workspace child','','','','','open',2,'task','2020-01-04 00:00:00','2020-01-04 00:00:00','{}'),
('demo-active','Review workspace','','','','','in_progress',2,'task','2020-01-05 00:00:00','2020-01-05 00:00:00','{}'),
('demo-closed','Closed workspace task','','','','','closed',3,'bug','2020-01-06 00:00:00','2020-01-06 00:00:00','{}'),
('demo-deferred','Future workspace task','','','','','open',4,'task','2020-01-07 00:00:00','2020-01-07 00:00:00','{}');
UPDATE issues SET assignee='alice' WHERE id='demo-active';
UPDATE issues SET defer_until='2099-01-01 00:00:00' WHERE id='demo-deferred';
UPDATE issues SET closed_at='2020-01-08 00:00:00' WHERE id='demo-closed';
UPDATE issues SET is_blocked=1 WHERE id='demo-blocked';
INSERT INTO labels (issue_id,label) VALUES ('demo-ready','browser'),('demo-ready','release'),('demo-blocked','release'),('demo-child','browser');
INSERT INTO dependencies (id,issue_id,depends_on_issue_id,type,created_at,created_by) VALUES
('11111111-1111-4111-8111-111111111111','demo-blocked','demo-ready','blocks','2020-01-01 00:00:00','fixture'),
('22222222-2222-4222-8222-222222222222','demo-child','demo-root','parent-child','2020-01-01 00:00:00','fixture');
CALL DOLT_ADD('-A');
CALL DOLT_COMMIT('-m','Portable Beads browser fixture','--author','Browser fixture <fixture@example.invalid>');
`);
run(['gc']);
const hashResult=JSON.parse(run(['sql','-r','json','-q',"SELECT DOLT_HASHOF('HEAD') AS hash"]));
const commit=hashResult.rows[0].hash;
const files=[];
async function snapshotFiles(dir,prefix=''){
 for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const path=prefix+entry.name;
  if(entry.isDirectory() && entry.name==='oldgen')await snapshotFiles(join(dir,entry.name),path+'/');
  else if(entry.isFile() && /^[0-9a-v]{32}(\.darc)?$/.test(entry.name) && entry.name!=='vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv'){
   await mkdir(join(output,'snapshot',prefix),{recursive:true}); await copyFile(join(dir,entry.name),join(output,'snapshot',path));
   const bytes=await readFile(join(dir,entry.name));files.push({url:`snapshot/${path}`,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
 }
}
await snapshotFiles(join(directory,'.dolt/noms'));
const manifestBytes=await readFile(join(directory,'.dolt/noms/manifest'));
await writeFile(join(output,'snapshot/manifest'),manifestBytes);
const descriptor={apiVersion:1,commit,files,manifest:{url:'snapshot/manifest',size:manifestBytes.length,sha256:createHash('sha256').update(manifestBytes).digest('hex')}};
await writeFile(join(output,'snapshot.json'),JSON.stringify(descriptor,null,2));
const cases=[
 // "id" is sorted outside issueops by the native CLI; use SQL-defined ordering here.
 {name:'list-all',request:{operation:'list',issueFilter:{SortBy:'title'}}},
 ...['priority','oldest','hybrid'].map(sort=>({name:`ready-${sort}`,request:{operation:'ready',workFilter:{Status:'open',SortPolicy:sort}}})),
 {name:'ready-api-default-status',request:{operation:'ready',workFilter:{SortPolicy:'priority'}}},
 {name:'blocked',request:{operation:'blocked',workFilter:{}}},
 {name:'statuses',request:{operation:'list',issueFilter:{Statuses:['open','in_progress'],SortBy:'title'}}},
 {name:'status-priority',request:{operation:'list',issueFilter:{Status:'open',PriorityMax:1,SortBy:'priority',Limit:3}}},
 {name:'labels-and',request:{operation:'list',issueFilter:{Labels:['browser','release']}}},
 {name:'labels-or',request:{operation:'list',issueFilter:{LabelsAny:['browser','release'],SortBy:'title'}}},
 {name:'labels-exclusion',request:{operation:'list',issueFilter:{ExcludeLabels:['browser'],SortBy:'title'}}},
 {name:'parent',request:{operation:'list',issueFilter:{ParentID:'demo-root'}}},
 {name:'parentless',request:{operation:'list',issueFilter:{NoParent:true,SortBy:'title'}}},
 {name:'text',request:{operation:'list',query:'workspace',issueFilter:{SortBy:'title'}}},
 {name:'metadata',request:{operation:'list',issueFilter:{HasMetadataKey:'area'}}},
 {name:'bound-text-is-data',request:{operation:'list',query:"' OR 1=1 --",issueFilter:{}}},
 {name:'empty',request:{operation:'list',issueFilter:{IDs:['missing']}}},
 {name:'ready-parent',request:{operation:'ready',workFilter:{ParentID:'demo-root',Status:'open',SortPolicy:'priority'}}},
 {name:'ready-label',request:{operation:'ready',workFilter:{Labels:['browser'],Status:'open',SortPolicy:'priority'}}},
 {name:'ready-unassigned',request:{operation:'ready',workFilter:{Unassigned:true,Status:'open',SortPolicy:'priority'}}},
 {name:'include-deferred',request:{operation:'ready',workFilter:{IncludeDeferred:true,Status:'open',SortPolicy:'priority'}}},
];
const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const config=resolve('build/fixture/server.yaml');
await mkdir('.cache',{recursive:true});
await writeFile(config,`log_level: error\ndata_dir: ${resolve('build/fixture')}\ncfg_dir: ${resolve('build/fixture/config')}\nbehavior:\n  read_only: true\n  event_scheduler: "OFF"\n  auto_gc_behavior:\n    enable: false\nlistener:\n  host: 127.0.0.1\n  port: ${port}\n  socket: .cache/native-fixture.sock\n`);
const server=spawn('dolt',['sql-server','--config',config],{stdio:['ignore','pipe','pipe']});let log='';
server.stdout.on('data',chunk=>{log+=chunk});server.stderr.on('data',chunk=>{log+=chunk});const exited=new Promise(resolve=>server.once('exit',resolve));
try{
 let started=false;
 for(let attempt=0;attempt<150;attempt++){
  if(server.exitCode!==null)throw new Error('Native fixture server failed: '+log);
  started=await new Promise(resolve=>{const socket=connect({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',()=>resolve(false));});
  if(started)break;await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.ok(started,'Native fixture did not start');
 const dsn=`root@tcp(127.0.0.1:${port})/db%2F${commit}?parseTime=true`;
 const baseline=execFileSync(native,['--compare',dsn,commit],{input:cases.map(test=>JSON.stringify(test.request)).join('\n')+'\n',encoding:'utf8',maxBuffer:8<<20}).trim().split('\n').map(line=>JSON.parse(line));
 baseline.forEach((value,index)=>assert.ok(!value.error,`${cases[index].name}: ${value.error}`));
 assert.equal(baseline[0].issues.length,7);assert.equal(baseline[5].issues.length,1);
 const ids=name=>baseline[cases.findIndex(test=>test.name===name)].issues?.map(issue=>issue.id)??[];
 assert.deepEqual(ids('labels-and'),['demo-ready']);assert.deepEqual(ids('parent'),['demo-child']);assert.deepEqual(ids('metadata'),['demo-ready']);
 assert.ok(!ids('ready-priority').includes('demo-blocked'));assert.ok(!ids('ready-priority').includes('demo-deferred'));assert.ok(ids('include-deferred').includes('demo-deferred'));
 await writeFile(join(output,'cases.json'),JSON.stringify(cases.map((test,i)=>({...test,expected:baseline[i]})),null,2));
}finally{server.kill('SIGTERM');const timer=setTimeout(()=>server.kill('SIGKILL'),5000);await exited;clearTimeout(timer);await writeFile('build/fixture/server.log',log);}
console.log(JSON.stringify({fixtureCommit:commit,files:files.length,cases:cases.length}));
