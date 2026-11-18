import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';

test('classic Worker script remains available through asynchronous startup and is released on reply, error, disposal or constructor failure', async () => {
  const originals = { fetch: globalThis.fetch, Worker: globalThis.Worker, location: globalThis.location, revoke: URL.revokeObjectURL };
  const revoked = [], workers = [];
  let rejectConstruction = false;
  class AsyncWorker {
    constructor(url) { this.url = url; if (rejectConstruction) throw new Error('Worker unavailable'); workers.push(this); }
    postMessage(message) {
      queueMicrotask(() => {
        if (!this.started && revoked.includes(this.url)) { this.onerror(); return; }
        this.started = true;
        this.onmessage({ data: { apiVersion: 1, id: message.id, result: { commit: 'head', root: 'root' } } });
      });
    }
    terminate() { this.terminated = true; }
  }
  const code = '/* fixture classic worker */';
  const entry = path => ({ path, size: path === 'worker.js' ? code.length : 1, sha256: createHash('sha256').update(path === 'worker.js' ? code : 'x').digest('hex') });
  const manifest = { schemaVersion: 1, apiVersion: 1, sourceCommit: 'a'.repeat(40), target: 'js/wasm', readOnly: true, files: ['worker.js', 'engine.wasm', 'wasm_exec.js'].map(entry) };
  try {
    globalThis.Worker = AsyncWorker;
    globalThis.location = new URL('https://page.example/');
    globalThis.fetch = async url => new Response(String(url).endsWith('manifest.json') ? JSON.stringify(manifest) : code);
    URL.revokeObjectURL = url => { revoked.push(url); originals.revoke.call(URL, url); };
    const source = await readFile(new URL('../src/client.ts', import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
    const { BeadsBrowserEngine } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
    const create = () => BeadsBrowserEngine.create({ baseURL: 'https://engine.example/' });
    const engine = await create();
    assert.equal(revoked.length, 0, 'new Worker does not imply its script was fetched');
    assert.deepEqual(await engine.open({ apiVersion: 1, files: [], manifest: {} }), { commit: 'head', root: 'root' });
    assert.deepEqual(revoked, [workers[0].url]);
    engine.dispose(); assert.equal(revoked.length, 1);
    const unused = await create(); unused.dispose(); assert.equal(revoked.length, 2);
    const broken = await create(); workers.at(-1).onerror(); broken.dispose(); assert.equal(revoked.length, 3);
    rejectConstruction = true;
    await assert.rejects(create(), /Worker unavailable/); assert.equal(revoked.length, 4);
  } finally {
    globalThis.fetch = originals.fetch; globalThis.Worker = originals.Worker; globalThis.location = originals.location; URL.revokeObjectURL = originals.revoke;
  }
});
