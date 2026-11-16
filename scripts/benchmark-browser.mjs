// Local loopback browser comparison; never exposes private data outside 127.0.0.1.
import { createServer } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const directory = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node scripts/benchmark-browser.mjs PRIVATE_PROFILE_DIRECTORY');
const profile = JSON.parse(await readFile(join(directory, 'profile.json')));
const releaseBytes = await readFile('dist/manifest.json'), release = JSON.parse(releaseBytes);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const references = new Map(), descriptors = new Map();
for (const arm of ['original-full', 'current-head']) {
  const files = (await readdir(join(directory, arm))).filter(name => name.endsWith('.nbs')).sort();
  const descriptor = { apiVersion: 1, files: [] };
  for (const file of [...files, 'manifest']) {
    const path = `/input/${arm}/${file}`, bytes = await readFile(join(directory, arm, file));
    references.set(path, join(directory, arm, file));
    const reference = { url: path, size: bytes.length, sha256: digest(bytes) };
    if (file === 'manifest') descriptor.manifest = reference; else descriptor.files.push(reference);
  }
  descriptors.set(`/snapshot/${arm}`, descriptor);
}
const assets = new Set(['manifest.json', ...release.files.map(file => file.path)]);
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('Cache-Control', 'no-store');
    if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Private native snapshot benchmark</title>'); return; }
    if (descriptors.has(path)) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(descriptors.get(path))); return; }
    if (references.has(path)) { response.end(await readFile(references.get(path))); return; }
    const asset = path.replace(/^\/assets\//, '');
    if (path.startsWith('/assets/') && assets.has(asset)) { response.setHeader('Content-Type', asset.endsWith('.js') ? 'text/javascript' : asset.endsWith('.wasm') ? 'application/wasm' : 'application/json'); response.end(await readFile(join('dist', asset))); return; }
    response.writeHead(404); response.end();
  } catch { response.writeHead(500); response.end('Local benchmark read failed'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const samples = []; const canonical = response => JSON.stringify((response.issues ?? []).map(issue => JSON.stringify(issue)).sort());
let expected;
try {
  const page = await browser.newPage(); await page.goto(base);
  await page.evaluate(async () => { window.engineModule = await import('/assets/client.js'); });
  // One browser/JIT warmup per arm, five unchanged control repetitions,
  // then six alternating pairs. Each measurement gets a fresh Worker/store.
  const order = ['original-full', 'current-head', ...Array(5).fill('original-full')];
  for (let pair = 0; pair < 6; pair++) order.push(...(pair % 2 ? ['current-head', 'original-full'] : ['original-full', 'current-head']));
  for (const [index, arm] of order.entries()) {
    const sample = await page.evaluate(async ({ arm, expectedManifestSha256, queries }) => {
      const snapshot = await (await fetch('/snapshot/' + arm)).json();
      for (const reference of [...snapshot.files, snapshot.manifest]) reference.url = new URL(reference.url, location.origin).href;
      const start = performance.now();
      const engine = await window.engineModule.BeadsBrowserEngine.create({ baseURL: location.origin + '/assets/', expectedManifestSha256, timeoutMs: 180000 });
      try {
        const created = performance.now(), metadata = await engine.open(snapshot), opened = performance.now();
        const results = []; const queryMs = [];
        for (const query of queries) { const before = performance.now(); results.push(await engine.query(JSON.parse(query))); queryMs.push(performance.now() - before); }
        const end = performance.now(), state = await engine.state();
        return { arm, createMs: created - start, openMs: opened - created, queriesMs: end - opened, totalMs: end - start, queryMs, state, metadata, results };
      } finally { engine.dispose(); }
    }, { arm, expectedManifestSha256: digest(releaseBytes), queries: profile.queries });
    const results = sample.results.map(canonical); expected ??= results; assert.deepEqual(results, expected, 'Full native record parity');
    assert.deepEqual(sample.results.map(result => (result.issues ?? []).length), profile.resultCounts);
    assert.equal(sample.state.putRejected, true); assert.equal(sample.state.commitRejected, true);
    sample.resultHashes = results.map(digest); delete sample.results;
    sample.phase = index < 2 ? 'warmup' : index < 7 ? 'control-aa' : 'paired';
    samples.push(sample);
    await writeFile(join(directory, 'browser-profile.json'), JSON.stringify({ sourceCommit: release.sourceCommit, wasm: release.files.find(file => file.path === 'engine.wasm'), scope: 'Existing engine, actual private remote snapshot bytes, local loopback HTTP. Asset/WASM compilation caches warm after warmups; each run creates a new Worker. Not GitHub REST/device latency or production serving implementation.', parity: true, samples }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ index, arm, phase: sample.phase, openMs: sample.openMs, totalMs: sample.totalMs, heapAllocBytes: sample.state.heapAllocBytes }));
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
