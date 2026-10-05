# @statewalker/webrun-files-http

## What it is

A server stub that serves any `FilesApi` over HTTP, and a client stub that is a `FilesApi` whose
calls become HTTP requests. Both use only `Request`, `Response`, `ReadableStream` and `fetch`:

- **Server stub** (`newServerStub`): a `(Request) => Promise<Response>` handler. Mount it in Hono,
  Bun, Deno, a Cloudflare Worker, a Service Worker, or Node through an adapter.
- **Client stub** (`newClientStub`): takes any `fetch`, including the server stub itself.

## Why it exists

A `FilesApi` often lives somewhere else: on a server, in a worker that owns the storage, behind
authentication. Exposing it should not require a framework, WebDAV, or a different client per
runtime. With fetch primitives on both sides, the same pair runs in every JavaScript runtime and in
the browser, streams in both directions with backpressure, and can be tested in one process with no
network at all.

## How to use

```bash
pnpm add @statewalker/webrun-files-http @statewalker/webrun-files
```

`@statewalker/webrun-files-mem` comes along as a dependency: the server stub uses it as the default
`staging` for chunked uploads.

One entry point, `@statewalker/webrun-files-http`: ESM (`dist/esm/index.js`), CommonJS
(`dist/cjs/index.cjs`), types (`dist/index.d.ts`); sources in `src/`. `dist/esm/index.js` is
self-contained (no imports), so a browser can load it with a plain `<script type="module">`.

Exports: `newServerStub`, `newClientStub`, and the types `ServerStubOptions`, `ClientStubOptions`,
`FilesServerHandler` (the handler plus `sweepUploads`), `FetchHandler`, `ServerCapabilities`.

### `newServerStub(options)`

| Option | Default | |
| --- | --- | --- |
| `fs` | (required) | The file system served, or `(req) => FilesApi` to choose one per request (per user, per tenant, wrapped in a guard). |
| `basePath` | `"/"` | URL path prefix the handler is mounted at. |
| `onRequest(req)` | - | Runs first; a returned `Response` ends the request without touching any file system (auth, CORS preflight). |
| `onResponse(req, res)` | - | Runs on every response, errors included (headers, CORS). |
| `staging` | a `MemFilesApi` | Where chunked-upload parts wait until completion. |
| `minPartSize` | 5 MiB | Smallest part accepted, except the last. |
| `maxPartSize` | 64 MiB | Largest part accepted (`413` beyond). |
| `maxParts` | 10 000 | Most parts per upload. |
| `maxPageSize` | 256 | Largest listing page. |
| `methods` | both | `{ http, post }`: which verb forms are served. |

The returned handler also has `sweepUploads({ olderThan })`, which deletes abandoned uploads
(metadata and parts) older than `olderThan` milliseconds. Call it on a schedule.

### `newClientStub(options)` (async)

| Option | Default | |
| --- | --- | --- |
| `baseUrl` | (required) | Where the server stub is mounted. |
| `setHeaders(req)` | - | Adjust every request (auth, signing). |
| `fetch` | `globalThis.fetch` | Any `(Request) => Promise<Response>`, including a server stub. |
| `methods` | `"http"` | `"http"` sends `MKCOL`/`COPY`/`MOVE`/`DELETE`; `"post"` sends `POST ?op=...` for proxies that block unusual verbs. |
| `upload` | `"auto"` | `"stream"`, `"chunked"`, or `"auto"`: streaming in Node, Deno and Bun, chunked everywhere else. |
| `partSize` | the server's `minPartSize` | Part size for chunked uploads. |
| `pageSize` | the server's `maxPageSize` | Listing page size. |
| `retries` | 2 | Retries of a failed listing page or upload part. |

`newClientStub` is async because it first reads the server's capabilities, so part and page sizes
agree with the server.

## Examples

### Serve a directory with Hono and a bearer token

```typescript
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { NodeFilesApi } from '@statewalker/webrun-files-node';
import { newServerStub } from '@statewalker/webrun-files-http';

const files = newServerStub({
  fs: new NodeFilesApi({ rootDir: '/var/app/data' }),
  basePath: '/api/files',
  onRequest: (req) =>
    req.headers.get('Authorization') === `Bearer ${process.env.TOKEN}`
      ? undefined // continue
      : new Response('Unauthorized', { status: 401 }),
});

const app = new Hono();
app.all('/api/files', (c) => files(c.req.raw));
app.all('/api/files/*', (c) => files(c.req.raw));
serve({ fetch: app.fetch, port: 8080 });
```

### Use it from a client

```typescript
import { writeText } from '@statewalker/webrun-files';
import { newClientStub } from '@statewalker/webrun-files-http';

const files = await newClientStub({
  baseUrl: 'https://example.com/api/files',
  setHeaders: (req) => {
    const headers = new Headers(req.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return new Request(req, { headers, duplex: 'half' } as RequestInit);
  },
});

await writeText(files, '/notes/today.md', '# Today');
for await (const entry of files.list('/notes', { recursive: true })) console.log(entry.path);
```

A `setHeaders` that rebuilds the request must pass `duplex: "half"` when the body is a stream.

### Both ends in one process

```typescript
import { MemFilesApi } from '@statewalker/webrun-files-mem';

const server = newServerStub({ fs: new MemFilesApi() });
const files = await newClientStub({ baseUrl: 'http://local/', fetch: server });
```

No network is involved; the same `Request` and `Response` objects cross between the two. Useful for
tests, a Service Worker, or a worker that owns the storage.

## Internals

### The protocol

A `FilesApi` path maps to `{baseUrl}/{segment}/...`, every segment `encodeURIComponent`-ed.

| Call | Request | Answer |
| --- | --- | --- |
| capabilities | `GET {base}/?capabilities` | `{ version, minPartSize, maxPartSize, maxParts, maxPageSize, methods }` |
| `read` | `GET {path}`, `Range: bytes=s-e` for `start`/`length` | `200`/`206`, streamed; `404` (missing or a directory) and `416` read as empty |
| `stats`, `exists` | `HEAD {path}` | `X-File-Kind`; files add `X-File-Size`, `X-Last-Modified-Ms`; `404` -> `undefined` |
| `write` (stream) | `PUT {path}` with a streamed body | `204` |
| `write` (chunked) | `POST {path}?uploads` -> `{ uploadId }`; `PUT {path}?upload={id}&part={n}`; `POST {path}?upload={id}&complete={count}`; `DELETE {path}?upload={id}` to abort | `201`, `204` |
| `mkdir` | `MKCOL {path}` or `POST {path}?op=mkdir` | `204` |
| `copy`, `move` | `COPY`/`MOVE {path}` + `Destination: {target URL}`, or `POST {path}?op=copy\|move&to={target path}` | `204`; `404` -> `false` |
| `remove` | `DELETE {path}` or `POST {path}?op=remove` | `204`; `404` -> `false` |
| `list` | `GET {path}?list&recursive=1&after={path}&limit={n}` | `{ items, next? }` |

Errors come back as `{ "error": { "name", "message" } }` with a `4xx`/`5xx` status, including
errors the served file system throws. The client rethrows them with the same name and message.

`MKCOL`, `COPY` and `MOVE` are borrowed from WebDAV, but this is not WebDAV. The server accepts
both verb forms unless `methods: { http, post }` disables one; a disabled form answers `405`.

### Why every call is its own request

No state lives between requests except chunked uploads in `staging`. Listings come in pages: the
server takes at most `limit` entries from `fs.list(path, { recursive, after })` and stops the
iterator, so nothing stays open. The client's `list()` is one lazy iterator that asks for the next
page only after you have taken the current one. A failed page is retried after the last entry
actually yielded; because every `FilesApi` lists in the same order, each entry arrives exactly once.

### Why chunked uploads exist

Firefox and Safari cannot send streamed request bodies, and Chromium refuses them over HTTP/1.1.
Browsers therefore upload in parts:

- The client holds one part, plus one source chunk read ahead to learn whether more follows.
- Content that fits in one part is a single plain `PUT`.
- A failed part is retried under the same number; any other failure aborts the upload.

On the server, parts go to `staging`, never the target, as `{dd}/{uuid}-{nnnnnn}.bin` beside
`{dd}/{uuid}.json` (the target path and creation time), where `dd` is the id's first two characters.
Each part streams into staging, limited to `maxPartSize`. On completion every part must exist,
every part but the last must be at least `minPartSize`, and the request must address the path the
upload was opened for. The parts then stream one after another into `fs.write()` and are deleted,
whether that write succeeded or not. Upload ids must be UUIDs, so they cannot address other staging
paths, and an id grants nothing beyond its path.

### Streaming and backpressure

- **Reads.** The response body is a pull-based stream over `fs.read()`, so the server reads only as
  fast as the client consumes. Stopping a read early cancels the response, which closes the
  server-side iterator. The client passes its `AbortSignal` to `fetch`.
- **Streamed uploads.** The request body pulls one chunk from your source at a time, and the server
  writes it straight into `fs.write()`.

### Hooks and CORS

`onRequest` runs before anything else, `OPTIONS` included, which the stub otherwise answers `204`.
`onResponse` sees every response, so CORS headers go there. To authorise by path, resolve `fs` per
request and wrap it, for example in `GuardedFilesApi` from `@statewalker/webrun-files-composite`.

### What breaks, and how it looks

- **Forcing `upload: "stream"` in a browser.** Chromium refuses a streamed body over HTTP/1.1
  ("Failed to fetch"); Firefox silently sends the text `[object ReadableStream]` as the body, which
  the server would store as the file. The client checks for request-stream support first and throws
  `webrun-files-http: this runtime cannot stream request bodies; use upload "chunked" or "auto"`.
- **Too many parts:** `webrun-files-http: <path> needs more than <maxParts> parts of <partSize>
  bytes; raise partSize`.
- **Paths.** The client throws `webrun-files-http: path must not contain ".."`. The server answers
  `400` (`Malformed path segment`, `Invalid path segment`) for an encoded `/`, `.` or `..` segment,
  and `404 Not under the files endpoint` outside `basePath`.
- **Uploads:** `400 Missing part <n>`, `409 Upload <id> was opened for another path`,
  `413 Part exceeds <max> bytes`, `404 Unknown upload: <id>`.
- **Several server processes.** An in-memory `staging` only works when every request of an upload
  reaches the same process. Give the stubs a shared persistent `staging` otherwise.
- An interrupted streamed upload restarts from the beginning; only chunked uploads retry per part.
- There are no conditional requests (`ETag`, `If-Match`): `FilesApi` has no content version.
- `move` and `copy` address one server; moving between two servers is not supported.

### Tests

- `pnpm test` runs the shared `createFilesApiTests` with streamed, chunked and `POST`-verb clients
  calling the server stub directly and over a real HTTP connection (`hono` with
  `@hono/node-server`, development dependencies only); the 256 MiB `createBigFilesApiTests`,
  streamed and chunked, both ways; and protocol, upload, streaming, path and hook tests.
- `pnpm test:e2e` builds and runs Playwright tests in Chromium and Firefox against `e2e/server.ts`
  (the server stub over memory at `/api/files`, the page from `e2e/public/` at `/`, the bundle at
  `/lib/webrun-files-http.js`). They cover text and binary writes, range reads, `stats`, `exists`,
  `mkdir`, `copy`, `move`, `remove`, paged recursive listings, a four-part chunked upload checked
  byte for byte, awkward names, absent files, and a forced streamed upload failing without storing
  anything.
- `pnpm e2e:serve` builds and serves the same page on `http://127.0.0.1:8080/` for manual use;
  query options `partSize`, `pageSize` and `upload` force several parts, several pages or an upload
  mode.
- WebKit is opt-in (`E2E_WEBKIT=1 pnpm test:e2e`). It needs `pnpm exec playwright install webkit`
  and system libraries that only `sudo pnpm exec playwright install-deps webkit` installs.

### Dependencies

`@statewalker/webrun-files` for the types and path helpers, `@statewalker/webrun-files-mem` for
the default staging area. Nothing else at runtime.

## License

MIT
