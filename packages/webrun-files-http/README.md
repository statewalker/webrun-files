# @statewalker/webrun-files-http

Serve any `FilesApi` over HTTP, and use it remotely as a `FilesApi` again — with nothing but
`Request`, `Response`, `ReadableStream` and `fetch` on both sides.

- **Server stub:** a `(Request) => Promise<Response>` handler. Mount it in Hono, Bun, Deno, a Cloudflare
  Worker, a Service Worker, or Node through an adapter.
- **Client stub:** a `FilesApi` whose calls become requests. It takes any `fetch`, including the
  server stub itself.
- **Every call is its own request:** reads stream with `Range`, uploads stream or go in parts,
  listings come in pages resumed with `after`.

## Installation

```bash
npm install @statewalker/webrun-files-http @statewalker/webrun-files
```

## Usage

### Server

```typescript
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { newServerStub } from "@statewalker/webrun-files-http";

const files = newServerStub({
  fs: new NodeFilesApi({ rootDir: "/var/app/data" }),
  basePath: "/api/files",
  onRequest: (req) =>
    req.headers.get("Authorization") === `Bearer ${process.env.TOKEN}`
      ? undefined // continue
      : new Response("Unauthorized", { status: 401 }),
});

const app = new Hono();
app.all("/api/files", (c) => files(c.req.raw));
app.all("/api/files/*", (c) => files(c.req.raw));
serve({ fetch: app.fetch, port: 8080 });
```

### Client

```typescript
import { readText, writeText } from "@statewalker/webrun-files";
import { newClientStub } from "@statewalker/webrun-files-http";

const files = await newClientStub({
  baseUrl: "https://example.com/api/files",
  setHeaders: (req) => {
    const headers = new Headers(req.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return new Request(req, { headers, duplex: "half" } as RequestInit);
  },
});

await writeText(files, "/notes/today.md", "# Today");
for await (const entry of files.list("/notes", { recursive: true })) console.log(entry.path);
```

`newClientStub` is async because it first reads the server's capabilities, so part and page sizes
agree with the server. A `setHeaders` that rebuilds the request must pass `duplex: "half"` when the
body is a stream.

### In one process

The client takes any `FetchHandler`, so the server stub can be its `fetch`. No network is involved,
and the same `Request` and `Response` objects cross between the two. This is useful for tests, for
a Service Worker, or for a worker that owns the storage:

```typescript
const server = newServerStub({ fs: new MemFilesApi() });
const files = await newClientStub({ baseUrl: "http://local/", fetch: server });
```

## Options

### `newServerStub(options)`

| Option | Default | |
| --- | --- | --- |
| `fs` | — | The file system served, or `(req) => FilesApi` to choose one per request (per user, per tenant, wrapped in `GuardedFilesApi`). |
| `basePath` | `"/"` | URL path prefix the handler is mounted at. |
| `onRequest(req)` | — | Runs first; a returned `Response` ends the request without touching any file system (auth, CORS preflight). |
| `onResponse(req, res)` | — | Runs on every response, errors included (headers, CORS). |
| `staging` | a `MemFilesApi` | Where chunked-upload parts wait until completion. Use a persistent one when several processes serve the same uploads. |
| `minPartSize` | 5 MiB | Smallest part accepted, except the last. |
| `maxPartSize` | 64 MiB | Largest part accepted (`413` beyond). |
| `maxParts` | 10 000 | Most parts per upload. |
| `maxPageSize` | 256 | Largest listing page. |
| `methods` | both | `{ http, post }`: which verb forms are served (see *Verbs*). |

The handler also has `sweepUploads({ olderThan })`, which deletes abandoned uploads (metadata and
parts) older than `olderThan` milliseconds. Call it on a schedule.

### `newClientStub(options)`

| Option | Default | |
| --- | --- | --- |
| `baseUrl` | — | Where the server stub is mounted. |
| `setHeaders(req)` | — | Adjust every request (auth, signing). |
| `fetch` | `globalThis.fetch` | Any `(Request) => Promise<Response>`, including a server stub. |
| `methods` | `"http"` | `"http"` sends `MKCOL`/`COPY`/`MOVE`/`DELETE`; `"post"` sends `POST ?op=…` for proxies that block unusual verbs. |
| `upload` | `"auto"` | `"stream"`, `"chunked"`, or `"auto"`: streaming in Node, Deno and Bun, chunked everywhere else. |
| `partSize` | the server's `minPartSize` | Part size for chunked uploads. |
| `pageSize` | the server's `maxPageSize` | Listing page size. |
| `retries` | 2 | Retries of a failed listing page or upload part. |

## Protocol

A `FilesApi` path maps to `{baseUrl}/{segment}/…`, with every segment `encodeURIComponent`-ed. The
client refuses a `..` segment. The server answers `400` for an encoded `/`, `.` or `..` segment, and
`404` outside `basePath`.

| Call | Request | Answer |
| --- | --- | --- |
| capabilities | `GET {base}/?capabilities` | `{ version, minPartSize, maxPartSize, maxParts, maxPageSize, methods }` |
| `read` | `GET {path}`, `Range: bytes=s-e` for `start`/`length` | `200`/`206`, streamed; `404` (missing or a directory) and `416` read as empty |
| `stats`, `exists` | `HEAD {path}` | `X-File-Kind`; files add `X-File-Size`, `X-Last-Modified-Ms`; `404` → `undefined` |
| `write` (stream) | `PUT {path}` with a streamed body | `204` |
| `write` (chunked) | `POST {path}?uploads` → `{ uploadId }`; `PUT {path}?upload={id}&part={n}`; `POST {path}?upload={id}&complete={count}`; `DELETE {path}?upload={id}` to abort | `201`, `204` |
| `mkdir` | `MKCOL {path}` or `POST {path}?op=mkdir` | `204` |
| `copy`, `move` | `COPY`/`MOVE {path}` + `Destination: {target URL}`, or `POST {path}?op=copy\|move&to={target path}` | `204`; `404` → `false` |
| `remove` | `DELETE {path}` or `POST {path}?op=remove` | `204`; `404` → `false` |
| `list` | `GET {path}?list&recursive=1&after={path}&limit={n}` | `{ items, next? }` |

Errors come back as `{ "error": { "name", "message" } }` with a `4xx`/`5xx` status, including
errors the served file system throws. The client rethrows them with the same name and message.

### Streaming

- **Reads.** The response body is a pull-based stream over `fs.read()`, so the server reads only as
  fast as the client consumes. Stopping a read early cancels the response, which closes the
  server-side iterator. The client passes its `AbortSignal` to `fetch`.
- **Streamed uploads.** The request body pulls one chunk from your source at a time, and the server
  writes it straight into `fs.write()`.
- **Why chunked uploads exist.** Firefox and Safari cannot send streamed request bodies, and
  Chromium refuses them over HTTP/1.1, so browsers use chunked uploads:
  - The client holds one part (plus one source chunk read ahead to learn whether more follows).
  - Content that fits in one part is a single plain `PUT`.
  - A failed part is retried under the same number, and any failure aborts the upload.

### Chunked uploads on the server

- **Staging layout.** Parts go to `staging`, never the target: `{dd}/{uuid}-{nnnnnn}.bin` beside
  `{dd}/{uuid}.json` (the target path and creation time), where `dd` is the id's first two characters.
- **Streaming and limits.** Each part streams into staging and is limited to `maxPartSize`.
- **Completion checks.** Every part must exist, every part but the last must be at least
  `minPartSize` (`400` otherwise), and the request must address the path the upload was opened
  for (`409` otherwise). An upload id grants nothing beyond that path.
- **Completion itself.** The parts stream one after another into `fs.write()`, then are deleted,
  whether that write succeeded or not.
- **Upload ids** must be UUIDs, so they cannot address other staging paths.

### Listings

The server takes at most `limit` entries from `fs.list(path, { recursive, after })`, then stops the
iterator, so nothing stays open between requests. `next` is present when the page is full.

The client's `list()` is one lazy iterator: it asks for the next page only after you have taken the
current one. A failed page is retried after the last entry actually yielded. Every `FilesApi` lists
in the same order, so that is exactly-once.

### Verbs

`MKCOL`, `COPY` and `MOVE` are borrowed from WebDAV, but this is not WebDAV. Proxies and gateways
that reject unusual verbs can be served with `methods: "post"` on the client. The server accepts both
forms unless `methods: { http, post }` disables one; a disabled form answers `405`.

### Hooks and CORS

- `onRequest` runs before anything else, `OPTIONS` included, which the stub otherwise answers `204`.
- `onResponse` sees every response, so CORS headers go there.
- To authorise by path, resolve `fs` per request and wrap it (for example in `GuardedFilesApi` from
  `@statewalker/webrun-files-composite`).

## Limitations

- An interrupted **streamed** upload restarts from the beginning; only chunked uploads retry per part.
- There are no conditional requests (`ETag`, `If-Match`), since `FilesApi` has no content version.
- An in-memory `staging` only works when every request of an upload reaches the same process.
- A `move` or `copy` across two servers is not supported: both paths address the same server.

## Testing

The package runs the shared suites four ways:
- `createFilesApiTests`: streamed, chunked and `POST`-verb clients calling the server stub directly;
- `createFilesApiTests` again over a real HTTP connection (`hono` with `@hono/node-server`, both
  development dependencies only);
- `createBigFilesApiTests` (256 MiB), streamed and chunked, both directly and over HTTP;
- protocol, upload, streaming, path and hook tests.

## License

MIT
