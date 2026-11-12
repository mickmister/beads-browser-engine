import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, copyFile, rm, cp, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const env = { ...process.env, GOTOOLCHAIN: 'go1.26.2', CGO_ENABLED: '0', GOMAXPROCS: process.env.GOMAXPROCS ?? '2' };
const go = args => execFileSync('go', args, { env, encoding: 'utf8', maxBuffer: 16<<20 });
await rm('dist', {recursive:true,force:true});
await mkdir('build/overlay', { recursive: true }); await mkdir('dist/licenses', { recursive: true });
go(['mod', 'download']); go(['mod', 'verify']);
const module = name => JSON.parse(go(['mod', 'download', '-json', name]));
const beads = module('github.com/steveyegge/beads@v1.2.2');
const vitess = module('github.com/dolthub/vitess@v0.0.0-20260728212736-0542037326d7');
async function writableDirectories(path){
 try{await chmod(path,0o755);for(const entry of await readdir(path,{withFileTypes:true}))if(entry.isDirectory())await writableDirectories(join(path,entry.name));}
 catch(error){if(error.code!=='ENOENT')throw error;}
}
// Go forbids overlays beneath GOMODCACHE. Copy authenticated pinned modules into
// build-private paths; never alter the shared module cache or checked-in go.mod.
for(const [name,entry] of [['beads',beads],['vitess',vitess]]){
 const destination=resolve(`.cache/upstream/${name}`);
 await writableDirectories(destination);await rm(destination,{recursive:true,force:true});await cp(entry.Dir,destination,{recursive:true});await writableDirectories(destination);entry.Dir=destination;
}
await copyFile('go.mod','build/go.mod'); await copyFile('go.sum','build/go.sum');
go(['mod','edit','-modfile=build/go.mod','-replace=github.com/steveyegge/beads=./.cache/upstream/beads','-replace=github.com/dolthub/vitess=./.cache/upstream/vitess']);
const auth = join(vitess.Dir, 'go/mysql/auth_server_static.go');
const original = await readFile(auth, 'utf8');
const start = original.indexOf('func (a *AuthServerStatic) installSignalHandlers() {');
const end = original.indexOf('\nfunc (a *AuthServerStatic) close()', start);
if (start < 0 || end < 0 || !original.slice(start,end).includes('syscall.SIGHUP')) throw new Error('Pinned Vitess portability patch no longer matches');
const patched = (original.slice(0,start) + 'func (a *AuthServerStatic) installSignalHandlers() {\n if a.file == "" { return }\n panic("file-backed native authentication is unavailable in browser WASM")\n}\n' + original.slice(end)).replace('\n\t"syscall"', '');
await writeFile('build/overlay/auth_server_static.go', patched);
await writeFile('build/overlay/hooks_js_wasm.go', '//go:build js && wasm\n\npackage hooks\nimport ("errors"; "github.com/steveyegge/beads/internal/types")\nfunc (r *Runner) runHook(path,event string,issue *types.Issue) error { return errors.New("native process hooks are unavailable in browser WASM") }\n');
await writeFile('build/overlay.json', JSON.stringify({ Replace: {
  [auth]: resolve('build/overlay/auth_server_static.go'),
  [join(beads.Dir, 'internal/hooks/hooks_js_wasm.go')]: resolve('build/overlay/hooks_js_wasm.go'),
} }));
const common = ['build','-modfile=build/go.mod','-mod=readonly','-p=2','-tags=gms_pure_go','-trimpath','-buildvcs=false','-ldflags=-s -w'];
execFileSync('go', [...common,'-overlay=build/overlay.json','-o','dist/engine.wasm','./engine'], { env:{...env,GOOS:'js',GOARCH:'wasm'}, stdio:'inherit' });
execFileSync('go', [...common,'-o','build/native','./engine'], { env, stdio:'inherit' });
const goroot = go(['env','GOROOT']).trim();
await copyFile(join(goroot,'lib/wasm/wasm_exec.js'),'dist/wasm_exec.js');
execFileSync('npx',['--no-install','tsc'],{stdio:'inherit'});
const used = go(['list','-modfile=build/go.mod','-mod=readonly','-tags=gms_pure_go','-f','{{if .Module}}{{if .Module.Replace}}{{.Module.Path}}|{{.Module.Version}}|{{.Module.Replace.Dir}}{{else}}{{.Module.Path}}|{{.Module.Version}}|{{.Module.Dir}}{{end}}{{end}}','-deps','./engine']);
const modules = [...new Set(used.trim().split('\n').filter(Boolean))].sort();
const licenses = [];
for (const record of modules) {
  const [path, version, dir] = record.split('|'); if (!dir || !version) continue;
  const names = (await readdir(dir)).filter(name => /^(LICENSE|LICENCE|COPYING|NOTICE)([.\-_].*)?$/i.test(name));
  if (!names.length) throw new Error(`Missing dependency license: ${path}`);
  for (const name of names) {
    const filename = path.replaceAll('/','_') + '-' + name;
    await copyFile(join(dir,name),join('dist/licenses',filename));
    licenses.push({ module:path, version, file:`licenses/${filename}` });
  }
}
await copyFile(join(goroot,'LICENSE'),'dist/licenses/Go-LICENSE');
await copyFile('LICENSE','dist/LICENSE');
await writeFile('dist/licenses.json',JSON.stringify(licenses,null,2)+'\n');
await writeFile('dist/engine.wasm.gz',gzipSync(await readFile('dist/engine.wasm'),{level:9}));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];
async function scan(dir='dist',prefix='') {
 for (const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
  const path = prefix+entry.name;
  if(entry.isDirectory()) await scan(join(dir,entry.name),path+'/');
  else { const bytes=await readFile(join(dir,entry.name)); files.push({path,size:bytes.length,sha256:sha256(bytes)}); }
 }
}
await scan();
const commit = process.env.ENGINE_SOURCE_SHA ?? execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected exact Git source SHA');
await writeFile('dist/manifest.json',JSON.stringify({schemaVersion:1,apiVersion:1,version:'0.1.0',sourceCommit:commit,target:'js/wasm',go:'1.26.2',beads:'1.2.2',readOnly:true,files},null,2)+'\n');
console.log(JSON.stringify({sourceCommit:commit,target:'js/wasm',files:files.length,wasm:files.find(f=>f.path==='engine.wasm')}));
