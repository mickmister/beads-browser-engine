// Opt-in local experiment. Private native data stays in the selected directory.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
const [directory, repository, commit] = process.argv.slice(2);
if (!directory || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Usage: node scripts/benchmark-workspace.mjs PRIVATE_DIRECTORY OWNER/REPOSITORY PINNED_GIT_COMMIT');
const root = resolve(directory), git = join(root, 'snapshot.git'), snapshot = join(root, 'full');
// A fresh directory prevents files from a previous snapshot contaminating a run.
await mkdir(root, { mode: 0o700 }); await mkdir(snapshot, { mode: 0o700 });
const command = (args, maxBuffer = 128 << 20) => execFileSync('git', args, { maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
command(['init', '--bare', git]);
const start = performance.now();
command([`--git-dir=${git}`, 'fetch', '--depth=1', `https://github.com/${repository}.git`, commit]);
const fetchMs = performance.now() - start;
const entries = command([`--git-dir=${git}`, 'ls-tree', '-rz', commit]).toString().split('\0').filter(Boolean).map(line => {
  const [header, path] = line.split('\t'), [mode, type, oid] = header.split(' '); return { mode, type, oid, path };
});
let bytes = 0, files = 0;
for (const entry of entries) {
  if (entry.type !== 'blob' || entry.path !== 'manifest' && !/^(?:oldgen\/)?[0-9a-v]{32}(?:\.darc)?$/.test(entry.path)) throw new Error(`Unexpected native snapshot entry: ${entry.path}`);
  const data = command([`--git-dir=${git}`, 'cat-file', 'blob', entry.oid]);
  const oid = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  if (oid !== entry.oid) throw new Error('Git blob integrity mismatch');
  const target = join(snapshot, entry.path); await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 }); await writeFile(target, data, { mode: 0o600 });
  bytes += data.length; files++;
}
const identity = { repository, gitCommit: commit, files, encodedBytes: bytes, gitFetchMs: fetchMs, transport: 'One shallow Git fetch; not the hosted GitHub REST blob transport. Downloaded bytes are private and never publication artifacts.' };
await writeFile(join(root, 'identity.json'), JSON.stringify(identity, null, 2), { mode: 0o600 });
console.log(JSON.stringify(identity));
