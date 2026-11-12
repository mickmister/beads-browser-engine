export interface FileReference { url: string; size: number; sha256: string }
export interface SnapshotReference { apiVersion: 1; commit: string; manifest: FileReference; files: FileReference[] }
export interface BeadsRequest {
  operation: 'list' | 'ready' | 'blocked';
  query?: string;
  /** Upstream Beads 1.2.2 filter names/casing; unknown fields are rejected in Go. */
  issueFilter?: Record<string, unknown>;
  workFilter?: Record<string, unknown>;
}
export interface BeadsResponse { issues: Record<string, unknown>[] | null }
export interface EngineState { putRejected: boolean; commitRejected: boolean; sealed: boolean; heapAllocBytes: number; heapSysBytes: number; stats: { uniqueChunks: number; decodedBytes: number; reads: number } }
export interface ReleaseManifest { schemaVersion: 1; apiVersion: 1; sourceCommit: string; target: 'js/wasm'; readOnly: true; files: { path: string; size: number; sha256: string }[] }

async function download(url: string, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok || !response.body) throw new Error('Asset request failed');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > max) throw new Error('Asset exceeds size bound'); chunks.push(result.value); }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
async function digest(bytes: Uint8Array<ArrayBuffer>) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join(''); }

/** One immutable snapshot per Worker. Cancellation/timeout terminates the Worker. */
export class BeadsBrowserEngine {
  private next = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private closed = false;
  private opened = false;
  private constructor(private worker: Worker, private assets: { wasm: FileReference; runtime: FileReference }, private timeoutMs: number) {
    worker.onmessage = event => {
      if (event.data?.apiVersion !== 1) return;
      if (event.data.id === 0 && event.data.error) { this.stop(new Error('Engine runtime failed')); return; }
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      if (event.data.error) pending.reject(new Error(event.data.error)); else pending.resolve(event.data.result);
    };
    worker.onerror = () => this.stop(new Error('Engine Worker failed'));
    worker.onmessageerror = () => this.stop(new Error('Invalid Worker message'));
  }
  static async create(options: { baseURL: string; expectedManifestSha256?: string; timeoutMs?: number }): Promise<BeadsBrowserEngine> {
    const base = new URL(options.baseURL.endsWith('/') ? options.baseURL : options.baseURL + '/', location.href);
    const bytes = await download(new URL('manifest.json', base).href, 256<<10);
    if (options.expectedManifestSha256 && await digest(bytes) !== options.expectedManifestSha256) throw new Error('Release manifest identity mismatch');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(bytes)) as ReleaseManifest;
    if (manifest.schemaVersion !== 1 || manifest.apiVersion !== 1 || manifest.target !== 'js/wasm' || manifest.readOnly !== true || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) || !Array.isArray(manifest.files) || manifest.files.length > 1000) throw new Error('Unsupported release manifest');
    const file = (path: string): FileReference => {
      const matches = manifest.files.filter(file => file.path === path);
      const entry = matches[0];
      if (matches.length !== 1 || !Number.isSafeInteger(entry.size) || entry.size <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid release file identity');
      return { url: new URL(path, base).href, size: entry.size, sha256: entry.sha256 };
    };
    const entry = file('worker.js');
    if (entry.size > 256<<10) throw new Error('Worker exceeds size bound');
    const code = await download(entry.url, entry.size);
    if (code.length !== entry.size || await digest(code) !== entry.sha256) throw new Error('Worker identity mismatch');
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try { return new BeadsBrowserEngine(new Worker(url), { wasm:file('engine.wasm'), runtime:file('wasm_exec.js') }, options.timeoutMs ?? 120000); }
    finally { URL.revokeObjectURL(url); }
  }
  private stop(error: Error) { this.closed = true; this.worker.terminate(); for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
  private call<T>(method: string, value: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Engine is disposed'));
    if (signal?.aborted) return Promise.reject(new Error('Operation aborted'));
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      const abort = () => this.stop(new Error('Operation aborted; create a new engine to resume'));
      const timer = setTimeout(() => this.stop(new Error('Engine operation timed out')), this.timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve(value) { cleanup(); resolve(value as T); }, reject(error) { cleanup(); reject(error); } });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.worker.postMessage({ apiVersion:1,id,method,value }); } catch { this.pending.get(id)?.reject(new Error('Unable to send engine request')); this.pending.delete(id); }
    });
  }
  async open(snapshot: SnapshotReference, signal?: AbortSignal): Promise<{ commit: string; root: string }> {
    if (this.opened) throw new Error('Engine already opened; create a new instance to refresh');
    this.opened = true;
    try { return await this.call('open', { assets:this.assets, snapshot }, signal); }
    catch (error) { this.dispose(); throw error; }
  }
  query(request: BeadsRequest, signal?: AbortSignal): Promise<BeadsResponse> { return this.call('query', request, signal); }
  state(signal?: AbortSignal): Promise<EngineState> { return this.call('state', null, signal); }
  dispose() { this.stop(new Error('Engine disposed')); }
}
