# @statewalker/webrun-files-rpc

## What it is

A `FilesApi` (from `@statewalker/webrun-files`) over any RPC, with streamed reads and writes.

- **Server** (`newFilesRpcServer({ fs })`): serves any `FilesApi` as plain method calls.
- **Client** (`newFilesRpcClient({ rpc })`): a `FilesApi` whose every call goes through those
  methods: a Durable Object or Workers RPC stub, comlink, `@statewalker/webrun-rpc`, or the server
  object itself.

Content moves as **chunks keyed by `(streamId, chunkId)`**. Both sides keep chunks by their key
and wait for the ones still on their way:
- the server answers `readChunk(streamId, k)` once chunk `k` exists;
- it writes chunk `k` once chunks `0..k-1` are written, whatever order they arrived in.

So the client can keep several chunks in flight, the transport may deliver calls out of order or
twice, and every byte still lands in order.

## Why it exists

A `FilesApi` streams: `read()` yields chunks and `write()` takes them. An RPC usually doesn't:
- Durable Object RPC carries a `ReadableStream` only on workerd; other Workers-compatible runtimes
  refuse it ("RPC streams cannot cross isolate boundaries").
- JSON and message-based transports have no streams at all.

`@statewalker/webrun-files-http` solves this for HTTP, where request and response bodies stream.
This package solves it for everything else: a stream becomes a sequence of ordinary calls, each
carrying one chunk, and any transport that can make a call can carry a file of any size.

Keys make the calls safe on real transports:
- **Pipelining:** several `readChunk` or `writeChunk` calls may be in flight; the answers are put
  back in order by `chunkId`.
- **Reordering:** a chunk that arrives early is kept until the ones before it are written.
- **Retries:**
  - a chunk written twice is written once;
  - a chunk read twice is answered twice;
  - an open with the same `streamId` opens one stream;
  - a `closeWrite` delivered again answers as the first did.
  - Metadata calls carry no key. Delivered twice with no other write in between, `mkdir`,
    `remove`, `move` and `copy` end in the same state, but each answers for the state it finds: a
    `remove`, `move` or `copy` delivered twice may report `false` though the first one did it. A
    `copy` retried after something else wrote to the target copies again.

## How to use

```bash
pnpm add @statewalker/webrun-files-rpc @statewalker/webrun-files
```

Inside this repository, depend on it with `"@statewalker/webrun-files-rpc": "workspace:^"`.

One entry point: ESM (`dist/esm/index.js`), CommonJS (`dist/cjs/index.cjs`), types
(`dist/index.d.ts`); sources in `src/`. The bundle has no imports: `@statewalker/webrun-files` is
used for its types only.

Exports:
- `newFilesRpcServer`, `newFilesRpcClient`, `FilesRpcClient`;
- `FilesRpcError` and `errorCode`;
- types `FilesRpc`, `FilesRpcServer`, `FilesRpcServerOptions`, `FilesRpcClientOptions`,
  `ReadResult`, `ListPage`, `ListPageOptions`, `OpenOptions`, `OpenReadOptions`,
  `FilesRpcErrorCode`.

### `newFilesRpcServer(options)`

| Option | Default | |
|---|---|---|
| `fs` | (required) | The `FilesApi` served. |
| `chunkSize` | 256 KiB | Largest chunk a read answers. |
| `readAhead` | 4 | Chunks produced ahead, counting from the highest one asked. |
| `retain` | 16 | A delivered chunk is dropped once the reader asked for one `retain` chunks past it (until then it can be asked again). |
| `window` | 64 | A read request may name a chunk at most `window` past the lowest chunk not yet delivered (`INVALID` beyond): what one stream makes the server pull and hold stays within `window + readAhead` chunks. |
| `writeWindow` | 16 | Chunks of a write kept ahead of the next one to write; a chunk beyond it waits (backpressure), one beyond two windows is refused. |
| `maxChunkSize` | 4 MiB | Largest chunk a write takes. |
| `idleTimeout` | 2 min | A stream not used for this long is dropped (a read closed, a write aborted). |
| `maxStreams` | 256 | Open streams at most (`TOO_MANY_STREAMS` beyond). |
| `maxPageSize` | 256 | Largest listing page. |
| `sweepInterval` | none | Sweep idle streams every this many ms. Without it, opening a stream sweeps; a server that stops receiving opens needs this (or calls to `sweep()`). |
| `now` | `Date.now` | The clock (tests). |

The server is a `FilesRpc` plus:
- `sweep()`: drops idle streams and returns how many (opening a stream also sweeps);
- `openStreams()`: how many streams are open;
- `close()`: ends every stream and stops the sweep timer. It doesn't wait for the FilesApi's
  writes to settle, and waits at most a second for sources to end.

### `newFilesRpcClient(options)`

| Option | Default | |
|---|---|---|
| `rpc` | (required) | The server's methods, through any transport. |
| `chunkSize` | 256 KiB | Bytes per chunk written (at most the server's `maxChunkSize`). |
| `readAhead` | 4 | `readChunk` calls in flight while reading (below the server's `window`). |
| `writeAhead` | 4 | `writeChunk` calls not yet answered while writing. |
| `pageSize` | 256 | Listing page size. |

### The protocol (`FilesRpc`)

Every argument and result is a plain value: strings, numbers, booleans, plain objects and
`Uint8Array`.

| Call | Answer |
|---|---|
| `openRead(path, {start?, length?, streamId?})` | `{streamId}`; a file that does not exist reads as nothing |
| `readChunk(streamId, chunkId)` | `{data, done}` once chunk `chunkId` exists; past the end `{data: empty, done: true}` |
| `closeRead(streamId)` | ends the stream (unknown or ended: nothing happens) |
| `openWrite(path, {streamId?})` | `{streamId}`; the `FilesApi`'s `write` starts consuming chunks in order |
| `writeChunk(streamId, chunkId, data)` | resolves once the chunk is kept (within `writeWindow` of the next to write: at once) |
| `closeWrite(streamId, chunks)` | resolves once all `chunks` chunks are written |
| `abortWrite(streamId, reason?)` | cancels the write (unknown or ended: nothing happens) |
| `list(path, {recursive?, after?, limit?})` | `{entries, more}`; ask again with `after` = the last path |
| `stats`, `exists`, `mkdir`, `remove`, `move`, `copy` | as the `FilesApi` |

- **Stream ids:** `streamId` may be chosen by the caller: 16 to 128 characters of `[A-Za-z0-9_-]`,
  random, such as `crypto.randomUUID()` without dashes. Then an open delivered twice opens one
  stream; the client always does this.
- **Errors:** protocol errors are `FilesRpcError` with a `code`:
  - `UNKNOWN_STREAM`, `CHUNK_RELEASED`, `TOO_MANY_STREAMS`, `ABORTED`, `INVALID`.
  - The code also leads the message (`UNKNOWN_STREAM: …`), because a structured clone keeps an
    error's message but not its other properties. `errorCode(e)` reads it on either side.

## Examples

### Both ends in one process

```ts
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { newFilesRpcClient, newFilesRpcServer } from "@statewalker/webrun-files-rpc";

const server = newFilesRpcServer({ fs: new MemFilesApi() });
const files = newFilesRpcClient({ rpc: server }); // any transport carrying these calls works

await files.write("/notes/today.md", [new TextEncoder().encode("# Today\n")]);
for await (const chunk of files.read("/notes/today.md")) console.log(new TextDecoder().decode(chunk));
```

### Served by a Durable Object, called through its stub

```ts
import { DurableObject } from "cloudflare:workers";
import { newFilesRpcClient, newFilesRpcServer, type FilesRpcServer } from "@statewalker/webrun-files-rpc";

export class Files extends DurableObject {
  #files: FilesRpcServer = newFilesRpcServer({ fs: makeFilesApi(this.ctx) }); // any FilesApi
  openRead(path: string, o?: object) { return this.#files.openRead(path, o); }
  readChunk(id: string, k: number) { return this.#files.readChunk(id, k); }
  closeRead(id: string) { return this.#files.closeRead(id); }
  openWrite(path: string, o?: object) { return this.#files.openWrite(path, o); }
  writeChunk(id: string, k: number, d: Uint8Array) { return this.#files.writeChunk(id, k, d); }
  closeWrite(id: string, n: number) { return this.#files.closeWrite(id, n); }
  abortWrite(id: string, r?: string) { return this.#files.abortWrite(id, r); }
  list(path: string, o?: object) { return this.#files.list(path, o); }
  stats(path: string) { return this.#files.stats(path); }
  exists(path: string) { return this.#files.exists(path); }
  mkdir(path: string) { return this.#files.mkdir(path); }
  remove(path: string) { return this.#files.remove(path); }
  move(a: string, b: string) { return this.#files.move(a, b); }
  copy(a: string, b: string) { return this.#files.copy(a, b); }
}

// In a Worker: the stub has the same methods, so it is the client's `rpc`.
const files = newFilesRpcClient({ rpc: env.FILES.get(env.FILES.idFromName("main")) as never });
```

A stream lives in the server's memory: keep one stream's calls on one Durable Object (they are,
through one stub).

### The protocol by hand

```ts
const server = newFilesRpcServer({ fs: new MemFilesApi(), chunkSize: 4 });
const streamId = crypto.randomUUID().replace(/-/g, "");
await server.openWrite("/a.txt", { streamId });
await Promise.all([
  server.writeChunk(streamId, 1, new TextEncoder().encode("world")), // out of order: kept
  server.writeChunk(streamId, 0, new TextEncoder().encode("hello ")),
]);
await server.closeWrite(streamId, 2); // resolves once both are written, in order

const { streamId: r } = await server.openRead("/a.txt");
for (let chunkId = 0; ; chunkId++) {
  const { data, done } = await server.readChunk(r, chunkId); // "hell", "o wo", "rld"
  if (done) break;
}
await server.closeRead(r);
```

`tests/readme.test.ts` runs the first and the last example as written.

## Internals

- **Reads:** `openRead` opens the `FilesApi`'s `read()` iterator; nothing is pulled yet.
  - `readChunk(k)` raises the highest id asked. A pump pulls the source until `readAhead` chunks
    from it exist, cutting the bytes into chunks of exactly `chunkSize`.
  - A chunk is cut only once more bytes follow it or the source has ended, so the last chunk
    carries `done: true` and no empty chunk is needed.
  - Chunks wait in a keyed store (`src/keyed.ts`); a request for a chunk not produced yet waits
    there.
  - If the source fails, the bytes before the failure are still served, and later chunks fail
    with its error.
- **Release:** a delivered chunk is dropped once the reader asked for one `retain` chunks past it.
  - A chunk below that line that nobody has received yet (asked out of order, or still to be
    produced) is kept until its first delivery. So a client asking further ahead than the server
    retains still gets every chunk.
  - A chunk delivered and dropped is `CHUNK_RELEASED`.
- **Writes:** `openWrite` starts the `FilesApi`'s `write()` at once, on a generator that yields
  the stream's chunks in key order and waits for the next one.
  - `writeChunk` keeps a copy of its chunk; a view of a larger buffer is cut out.
  - A chunk at or beyond `next + writeWindow` waits until the window moves; one at or beyond
    `next + 2 × writeWindow` is refused (`INVALID`). So a writer makes the server hold at most two
    windows of chunks.
  - `closeWrite(n)` tells the generator where to stop and waits for `write()` to finish. If more
    than `n` chunks arrived, the write fails with `INVALID`.
  - `abortWrite`, expiry and `close()` make the generator throw, so `write()` fails. What then
    remains of the file is up to the `FilesApi`: `MemFilesApi` writes only at the end, so the file
    keeps what it had.
  - `write()` starts at `openWrite`, not at the first chunk. A FilesApi that truncates when a
    write starts has emptied the file already if the write is then aborted.
- **Ended streams:** ids that ended are remembered for `idleTimeout`. Within that time, an open
  delivered after its stream ended does not reopen it, and a `closeWrite` delivered again gets the
  first answer.
- **Idle and busy:** a stream is idle when nothing happened on it for `idleTimeout`: no call
  started or ended, and (writes) the FilesApi took no chunk.
  - A `readChunk` waiting on a slow source keeps its stream alive, and so does a write whose next
    chunk is there for the FilesApi to take.
  - A write waiting only for the holder (`writeChunk` waiting for room, `closeWrite` waiting for a
    missing chunk) is swept once idle; its waiting calls fail with `ABORTED`.
  - A write whose chunks were all handed to the FilesApi is never swept. An `abortWrite` arriving
    then is too late and does nothing (the commit stands).
- **Failures:** a write the FilesApi fails keeps its stream until it is closed, aborted or swept,
  so the next `writeChunk` or `closeWrite` reports that failure, not `UNKNOWN_STREAM`. A source
  yielding something that is not bytes fails the stream with `INVALID`.
- **Bounds:** a read request beyond `window` is refused at once, so asking for chunk
  1,000,000,000 neither loops nor loads anything.
- **The client:**
  - **Read:** it keeps `readAhead` `readChunk` calls in flight and yields the answers in key
    order. Breaking out of the loop, or aborting through `signal`, closes the stream.
  - **Write:** it cuts any sequence of byte arrays into chunks of exactly `chunkSize` and keeps
    `writeAhead` unanswered. Any failure (of the source, or of a call) aborts the write.
  - **List:** it asks page after page with `after`. The server also applies `after` itself, in
    code-point order, so a FilesApi that ignores it cannot make pages repeat.
- **Not covered:**
  - A stream lives in one server's memory; a server restart loses open streams (`UNKNOWN_STREAM`).
  - Serializing `Uint8Array` for a JSON-only transport (base64, msgpack) is the transport's job.
  - Per-caller authorization is the `FilesApi`'s or the transport's job: serve a guarded
    `FilesApi`.

## Tests

`pnpm --filter @statewalker/webrun-files-rpc test` (Vitest; build the workspace first, the
shared suites are imported from `webrun-files-tests`' `dist/`). The protocol tests use their own
pseudo-random bytes and the transport simulator in `tests/helpers.ts`; byte collection and text
encoding come from `webrun-files-tests`.

| File | Covers |
|---|---|
| `server-read.test.ts` | numbered chunks with `done`, out-of-order and concurrent requests, ranges, missing files, retries, release, bounded read-ahead, closing, failing sources |
| `server-write.test.ts` | in-order and out-of-order chunks, duplicates, backpressure, `closeWrite` waiting for a gap or refusing a wrong count, empty files, abort, failing writes, byte types |
| `server-lifecycle.test.ts` | idle expiry, the stream limit, `close()`, unguessable ids, paged listing, metadata |
| `protocol.test.ts` | caller-chosen keys (opens and `closeWrite` delivered twice, after the end), what is refused, waiting requests failed by a close, error codes across a structured clone, many streams at once, release never dropping an undelivered chunk, metadata calls delivered twice |
| `robustness.test.ts` | the window (huge chunk ids refused at once, bounded pulls), busy streams not swept, writes too far ahead refused, writes waiting for the holder swept, the sweep timer, a failing write's error reaching the client, a late abort not undoing a commit, a source yielding non-bytes, waiters past the count, aborting a hanging read, `close()` not hanging, listing with a FilesApi that ignores `after` |
| `client.test.ts` | the `FilesApi` round trip, iterables, ranges, pipelining depth, early stop and abort, failing sources, write depth, listing; delayed, reordered and duplicated calls (five seeds) |
| `conformance.test.ts` | the repository's `FilesApi` suite (`webrun-files-tests`) on the client over the server: directly, and through the transport simulator (cloned, reordered, every call but `remove`/`move`/`copy` delivered twice at random) |
| `big-files.test.ts` | the repository's big-file suite (64 MiB) on the client over the server, every call structured-cloned |
| `readme.test.ts` | the examples above |
