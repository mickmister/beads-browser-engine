# Beads browser engine

Read an immutable native Beads/Dolt snapshot in a browser Worker using the actual
upstream Beads read operations. One `GOOS=js GOARCH=wasm` release serves all
supported browsers; there are no separate ARM and x86 browser binaries.

The engine verifies native table/archive files and chunks, opens the pinned Dolt
commit, and executes upstream `issueops` over a read-only SQL adapter backed by
Dolt schema/prolly readers and go-mysql-server. Query results are computed from
native binary data, not from exported issue JSON or a hosted SQL endpoint.

## Build and verify

Requirements: Node 22+, Git, Go with toolchain downloading enabled, and a Linux
x64 host for the included checksum-pinned Dolt installer. Go 1.26.2 is selected by
the build script. The native comparator runs on the build host; only the portable
WASM/JS release goes to browsers.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
GOTOOLCHAIN=go1.26.2 go test -modfile=build/go.mod -mod=readonly -tags=gms_pure_go ./engine
node scripts/install-dolt.mjs
PATH="$PWD/.cache/dolt:$PATH" npm run fixture
node scripts/selftest-publication.mjs
npx playwright install --with-deps chromium firefox webkit
npm run test:browser
```

`dist/manifest.json` records the Git source commit and every release file's raw
size and SHA-256. Build a clean committed checkout for release provenance.
`ENGINE_SOURCE_SHA` is supplied by CI and must identify the checkout. Generated
files, caches and native fixture data are ignored by Git. Building does not alter
the shared Go module cache. The one-time `tools/import-prototype.mjs` is historical
source-import tooling and is not needed to build or test.

Pins: Beads v1.2.2 (upstream commit
`6c124203e771433a3550c348771a5b5e27fd3c21`), Dolt Go module
`v0.40.5-0.20260819193234-b15770fe5882`, go-mysql-server
`v0.20.1-0.20260818234004-b83dd092a5eb`, Vitess
`v0.0.0-20260728212736-0542037326d7`, and native Dolt CLI 2.3.1. `go.sum` and
`package-lock.json` pin dependencies. The Go module path remains
`github.com/steveyegge/beads/browserengine` to allow upstream internal imports.
Build-private browser overlays make native process hooks and file-backed auth
signal handling explicitly unsupported; they do not silently succeed.

### Verification coverage

Every push and pull request runs `.github/workflows/ci.yml`. Its reusable
verification workflow builds once, generates a fresh synthetic native database,
and compares complete JSON results from 21 upstream Beads operations against a
separate read-only native Dolt SQL server at the same commit. The fixture includes
labels, metadata, parent/child and blocking edges, closed/in-progress issues and
deferred work. Baseline assertions prevent vacuous empty-result comparisons.

The same release artifact is tested in Chromium, Firefox and WebKit on Linux and
WebKit on `macos-latest`. Evidence records `process.arch` rather than assuming
the macOS host's CPU. Tests cover ordered results, null/empty distinctions,
read-only enforcement, invalid input, file corruption, cancellation and replay.
Browser evidence includes heap/chunk statistics and fixture-scale timing; this
is not production-scale memory/performance acceptance. Linux WebKit is not a
claim of packaged Safari or iOS acceptance.

The HTTP publisher selftest uploads the actual release bytes, checks signed and
public readback, gzip, CORS and immutable replay using a loopback S3 test server.
It is not a test against Cloudflare or AWS credentials.

## Browser API

Serve/import `client.js` as an ES module. Its generated `client.d.ts` contains
the API types. Pin a release's manifest hash from the verified publication
receipt in trusted host configuration:

```js
import { BeadsBrowserEngine } from './client.js';

const engine = await BeadsBrowserEngine.create({
  baseURL: releaseURL, // public prefix + commits/<40-character source SHA>/
  expectedManifestSha256: trustedManifestSha256,
  timeoutMs: 120000,
});
try {
  await engine.open(snapshotReference);
  const { issues } = await engine.query({
    operation: 'ready',
    workFilter: { Status: 'open', SortPolicy: 'priority' },
  });
  console.log(issues);
} finally {
  engine.dispose();
}
```

`open`, `query` and `state` accept an optional `AbortSignal`. Cancellation or an
operation timeout terminates the whole isolated Worker and rejects pending work.
Refresh by creating a new instance for the new immutable snapshot. A failed open
also disposes its instance. Query errors are rejected promises.

Operations are `list`, `ready`, and `blocked`. Filters retain **upstream Go field
names and casing** (`issueFilter`, `workFilter` contents); unknown fields are
rejected. These are upstream transaction-level read semantics, not all CLI
defaults or post-processing. In particular, `ready` does not implicitly add
`Status: 'open'`. For ordered lists use upstream SQL sort keys such as `priority`,
`title`, `created`, `updated`, `status`, `type`, `assignee`, or `closed`.
`SortBy: 'id'` disables upstream SQL ordering because the native CLI sorts it
later; this low-level API does not provide that CLI post-processing. Do not rely
on its row order or limited subset. Set a supported SQL sort for stable paging.
No arbitrary SQL or mutation API is exposed.

### Snapshot references and hosting

The host provides an authenticated, revision-pinned descriptor:

```ts
{
  apiVersion: 1,
  commit: string, // 32-character Dolt commit hash
  manifest: { url: string, size: number, sha256: string },
  files: [{ url: string, size: number, sha256: string }],
}
```

URLs should be absolute. `manifest` is the native `.dolt/noms/manifest`; `files`
are the complete required native table/archive files, including applicable
`oldgen` files. Preserve the complete immutable snapshot when publishing it.
`scripts/fixture.mjs` demonstrates extraction from a newly committed, GC'd
synthetic native database. Production snapshot export and host authorization are
the caller's responsibility. Hashes must originate from trusted pinned metadata;
fetching untrusted hashes alongside untrusted bytes does not authenticate them.

All asset/snapshot requests omit cookies. Use public or explicitly signed URLs
and allow the application origin through CORS. Secure context/Web Crypto, Workers
and WebAssembly are required. CSP must permit the asset/snapshot origins in
`connect-src`, the SDK import in `script-src`, Blob Workers (`worker-src blob:`),
Blob runtime scripts and WASM compilation (`script-src blob: 'wasm-unsafe-eval'`,
subject to browser support). The SDK verifies and constructs the Worker from a
Blob so CDN assets can live on another origin.

Current safety bounds: 128 MiB WASM, 512 snapshot files, 32 MiB per encoded native
file, 64 MiB aggregate encoded snapshot data, 256 MiB decoded chunk store,
100,000 chunks, 1 MiB request JSON and 10,000 SQL result rows. These are admission
limits, not a total browser memory cap. Worker disposal releases the runtime;
requests are serialized within an instance.

## Manual publication to R2 / S3

Create a bucket and public delivery route, then add the following **GitHub Actions
repository secrets**. Server configuration is read exclusively from secrets;
there are no repository-variable fallbacks or built-in server destinations.

| Secret | Value |
| --- | --- |
| `S3_ENDPOINT` | HTTPS account/service endpoint root, without bucket/path; for R2 use your account's S3 API endpoint. |
| `S3_REGION` | Signing region; R2 normally uses `auto`. |
| `S3_BUCKET` | Existing bucket name. |
| `S3_KEY_PREFIX` | Nonempty object prefix, e.g. `beads-engine` (no leading slash). |
| `S3_PUBLIC_BASE_URL` | HTTPS delivery root that **already maps to the bucket and key prefix**, e.g. `https://assets.example.com/beads-engine/`. |
| `S3_CORS_ALLOWED_ORIGINS` | JSON array, e.g. `["https://app.example.com"]`; `['*']` must instead be valid JSON `["*"]` if wildcard access is intended. |
| `S3_ACCESS_KEY_ID` | S3-compatible access key. |
| `S3_SECRET_ACCESS_KEY` | Matching secret key. |
| `S3_SESSION_TOKEN` | Optional temporary-credential token; omit for ordinary R2 keys. |

Credentials need object read/write under the prefix and bucket CORS read/write
permissions. The workflow merges a prefix-specific managed CORS rule, preserving
unrelated rules. Provision public delivery separately: the publisher does not
create a bucket, custom domain or public-access policy. R2's private S3 endpoint
is not its public delivery URL. A custom-domain path rewrite is allowed provided
the public base maps exactly to the configured prefix.

In **Actions → Publish verified engine to S3 → Run workflow**, choose the source
branch/ref and dispatch. The workflow checks out the exact dispatch SHA, runs the
entire verification matrix, then publishes that same artifact. You do not need to
edit the workflow or supply workflow inputs. Concurrent publications are queued.

For prefix `beads-engine`, the object key is:
`beads-engine/commits/<source SHA>/engine.wasm`; with public base
`https://assets.example.com/beads-engine/`, its delivery URL is
`https://assets.example.com/beads-engine/commits/<source SHA>/engine.wasm`.
Do not append the prefix twice or supply a base already ending in `commits/`.

Publication validates all local file hashes, signs path-style S3 requests,
conditionally creates immutable objects (`If-None-Match: *`), checks existing
content on reruns, and writes the completion manifest last. A failed partial
upload can be retried at the same commit; different existing bytes fail rather
than overwrite history. `engine.wasm` is served as gzip-encoded
`application/wasm`; its manifest hash describes the **decompressed** bytes. A
`.gz` sidecar is also published. Objects use one-year immutable caching.

Success requires signed readback and actual public GETs verifying every file's
raw hash, MIME, immutable cache headers, CORS and WASM gzip encoding. A proxy/CDN
must preserve these headers. Some S3 implementations may reject conditional
PUT or bucket CORS operations; those failures are reported, not bypassed.

Download the `verified-publication` artifact for `publication.json`: exact source
SHA, release path, manifest SHA-256, verified file count and verification flags.
It excludes server URLs and credentials. Derive the release URL from your secret
public base plus the receipt's `releasePath` and trailing `/`. Actual R2/S3
acceptance occurs when this workflow succeeds against your configured service.

## Licensing and scope

MIT project license; `SOURCE_PROVENANCE.json` records imported source hashes.
Each release includes the project license, Go license and dependency licenses
with a `licenses.json` index. Upstream dependencies retain their own licenses.
The repository contains only synthetic fixture generation, not workspace data.

This release is read-only. Native write transactions, effect markers, changeset
import, authorization and application UI integration are separate work. A CDN
stores the compiled engine; source remains in Git and Beads data remains native
Dolt. GitHub Actions here builds/tests/publishes software artifacts.
