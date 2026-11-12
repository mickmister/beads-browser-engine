// One-time, explicit import of the verified prototype. CI uses checked-in Go files.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const source = resolve(process.argv[2] ?? 'missing-prototype-directory');
await mkdir('engine', { recursive: true });
const files = ['beads.go', 'decode.go', 'driver.go', 'provider.go', 'query.go', 'snapshot.go', 'store.go', 'main_js.go'];
const provenance = [];
for (const name of files) {
  const bytes = await readFile(`${source}/${name}`);
  await writeFile(`engine/${name}`, bytes);
  provenance.push({ path: `engine/${name}`, importedSha256: createHash('sha256').update(bytes).digest('hex') });
}
let mod = await readFile(`${source}/go.mod`, 'utf8');
mod = mod.replace('module github.com/steveyegge/beads/browserproof', 'module github.com/steveyegge/beads/browserengine')
  .replace('replace github.com/dolthub/vitess => ../sql-worker/vitess', 'replace github.com/dolthub/vitess => github.com/dolthub/vitess v0.0.0-20260728212736-0542037326d7')
  .replace('replace github.com/steveyegge/beads => ../beads-wasm-native-probe/upstream\n', '');
await writeFile('go.mod', mod);
await writeFile('SOURCE_PROVENANCE.json', JSON.stringify({ source: 'Verified native Beads browser snapshot prototype; no workspace data imported.', beads: 'v1.2.2', beadsCommit: '6c124203e771433a3550c348771a5b5e27fd3c21', files: provenance }, null, 2) + '\n');
