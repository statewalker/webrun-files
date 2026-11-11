import type { FileInfo, FilesApi } from "@statewalker/webrun-files";
import { FilesRpcError } from "./errors.js";
import { Keyed } from "./keyed.js";
import type {
  AppendableFilesApi,
  FilesRpc,
  ListPage,
  OpenOptions,
  OpenReadOptions,
  OpenWriteOptions,
  ReadResult,
} from "./types.js";

export interface FilesRpcServerOptions {
  /** The file system served. */
  fs: FilesApi;
  /** Largest chunk a read stream answers. Default 256 KiB. */
  chunkSize?: number;
  /** Chunks produced ahead, counting from the highest one asked. Default 4. */
  readAhead?: number;
  /** A chunk is released once the reader asked for one `retain` chunks past it. Default 16. */
  retain?: number;
  /**
   * A read request may name a chunk at most this many past the lowest chunk not yet delivered
   * (INVALID beyond). Bounds what one stream makes the server pull and hold. Default 64.
   */
  window?: number;
  /**
   * Chunks of a write kept ahead of the next one to write. Default 16. One window more may wait
   * for room; a chunk beyond is refused (INVALID).
   */
  writeWindow?: number;
  /** Largest chunk a write takes. Default 4 MiB. */
  maxChunkSize?: number;
  /** A stream not used for this long is dropped (reads closed, writes aborted). Default 2 min. */
  idleTimeout?: number;
  /** Open streams at most. Default 256. */
  maxStreams?: number;
  /** Largest listing page. Default 256. */
  maxPageSize?: number;
  /** Sweeps idle streams every this many ms (default: only when a stream is opened). */
  sweepInterval?: number;
  /** The clock (tests). Default `Date.now`. */
  now?: () => number;
}

/** The server: the RPC methods, plus maintenance. */
export interface FilesRpcServer extends FilesRpc {
  /** Drops idle streams; returns how many. Opening a stream does it too. */
  sweep(): number;
  /** Streams open now. */
  openStreams(): number;
  /**
   * Ends every stream (reads closed, writes aborted) and stops the sweep timer. It does not wait
   * for the FilesApi's writes to settle, and waits at most a second for sources to end.
   */
  close(): Promise<void>;
}

interface ReadStream {
  kind: "read";
  touched: number;
  /** Calls in progress: a stream with any is not idle. */
  busy: number;
  source: AsyncIterator<Uint8Array>;
  chunks: Keyed<ReadResult>;
  /** Bytes pulled from the source, not yet a chunk. */
  buffer: Uint8Array[];
  buffered: number;
  /**
   * The next chunk id to produce; the highest asked; below `released`, chunks are dropped once
   * delivered (`delivered`: ids answered at least once and not yet dropped).
   */
  produced: number;
  /** Every chunk below `low` was delivered; `delivered`: those above it that were. */
  low: number;
  delivered: Set<number>;
  asked: number;
  released: number;
  ended: boolean;
  closed: boolean;
  error?: unknown;
  pumping?: Promise<void>;
}

interface WriteStream {
  kind: "write";
  touched: number;
  busy: number;
  /** Chunks received and not yet written, by id; the next id to write. */
  chunks: Map<number, Uint8Array>;
  next: number;
  /** Set by closeWrite: the stream's chunk count. */
  total?: number;
  /** Whoever waits for the next chunk (the FilesApi's write) or for room in the window. */
  wake?: () => void;
  room: { chunkId: number; resolve: () => void; reject: (e: unknown) => void }[];
  failure?: unknown;
  done: Promise<void>;
}

type Stream = ReadStream | WriteStream;

const EMPTY = new Uint8Array();
const STREAM_ID = /^[A-Za-z0-9_-]{16,128}$/;

function newStreamId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new FilesRpcError("INVALID", "a chunk is a Uint8Array or an ArrayBuffer");
}

function chunkIdOf(v: unknown): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new FilesRpcError("INVALID", `a chunk id is an integer from 0 (got ${String(v)})`);
  return n;
}

/** Orders paths by Unicode code point, as `FilesApi.list()` does (webrun-files' comparePaths). */
function comparePaths(a: string, b: string): number {
  const x = a[Symbol.iterator]();
  const y = b[Symbol.iterator]();
  for (;;) {
    const p = x.next();
    const q = y.next();
    if (p.done || q.done) return p.done && q.done ? 0 : p.done ? -1 : 1;
    const d = (p.value.codePointAt(0) as number) - (q.value.codePointAt(0) as number);
    if (d !== 0) return d;
  }
}

/** Joins the first `n` buffered bytes into one chunk. */
function take(s: ReadStream, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let at = 0;
  while (at < n) {
    const head = s.buffer[0] as Uint8Array;
    const part = head.subarray(0, n - at);
    out.set(part, at);
    at += part.length;
    if (part.length === head.length) s.buffer.shift();
    else s.buffer[0] = head.subarray(part.length);
  }
  s.buffered -= n;
  return out;
}

/** Serves a FilesApi as the FilesRpc methods. */
export function newFilesRpcServer(options: FilesRpcServerOptions): FilesRpcServer {
  const fs = options.fs;
  const chunkSize = Math.max(1, options.chunkSize ?? 256 * 1024);
  const readAhead = Math.max(1, options.readAhead ?? 4);
  const retain = Math.max(1, options.retain ?? 16);
  const window = Math.max(1, options.window ?? 64);
  const writeWindow = Math.max(1, options.writeWindow ?? 16);
  const maxChunkSize = Math.max(1, options.maxChunkSize ?? 4 * 1024 * 1024);
  const idleTimeout = options.idleTimeout ?? 2 * 60_000;
  const maxStreams = options.maxStreams ?? 256;
  const maxPageSize = Math.max(1, options.maxPageSize ?? 256);
  const now = options.now ?? Date.now;

  const streams = new Map<string, Stream>();
  /**
   * Streams that ended recently, by id: an open delivered again after its stream ended must not
   * open it anew, and a closeWrite delivered again answers as the first one did.
   */
  const ended = new Map<string, { at: number; failure?: unknown }>();

  const finish = (id: string, failure?: unknown) => {
    streams.delete(id);
    ended.set(id, { at: now(), failure });
  };

  const stream = <K extends Stream["kind"]>(id: string, kind: K): Extract<Stream, { kind: K }> => {
    const s = streams.get(String(id));
    if (!s || s.kind !== kind)
      throw new FilesRpcError("UNKNOWN_STREAM", `no open ${kind} stream '${String(id)}'`);
    s.touched = now();
    return s as Extract<Stream, { kind: K }>;
  };

  /** Runs `work` as a call in progress on `s`: the stream is not idle meanwhile. */
  const busy = async <T>(s: Stream, work: () => Promise<T>): Promise<T> => {
    s.busy++;
    try {
      return await work();
    } finally {
      s.busy--;
      s.touched = now();
    }
  };

  /** An id for a new stream, or the stream an open delivered twice already opened. */
  const claim = (
    opts: OpenOptions | undefined,
    kind: Stream["kind"],
  ): { id: string; existing?: Stream } => {
    const wanted = opts?.streamId;
    if (wanted !== undefined) {
      if (typeof wanted !== "string" || !STREAM_ID.test(wanted))
        throw new FilesRpcError("INVALID", "a stream id is 16 to 128 characters of [A-Za-z0-9_-]");
      const existing = streams.get(wanted);
      if (existing) {
        if (existing.kind !== kind)
          throw new FilesRpcError("INVALID", `stream '${wanted}' is a ${existing.kind} stream`);
        return { id: wanted, existing };
      }
      if (ended.has(wanted)) throw new FilesRpcError("INVALID", `stream '${wanted}' has ended`);
    }
    server.sweep();
    if (streams.size >= maxStreams)
      throw new FilesRpcError("TOO_MANY_STREAMS", `at most ${maxStreams} open streams`);
    return { id: wanted ?? newStreamId() };
  };

  // ---- reads ----

  /** Pulls the source until `readAhead` chunks from the highest asked exist, or it ends. */
  const wanted = (s: ReadStream) =>
    !s.ended && !s.closed && s.error === undefined && s.produced < s.asked + readAhead;
  const pump = (s: ReadStream): Promise<void> => {
    if (s.pumping) return s.pumping;
    const run = (async () => {
      // Started on the next tick: `s.pumping` is set before the loop can finish.
      await undefined;
      while (wanted(s)) {
        // A chunk is only cut once more bytes follow it (or the source ended), so the last one
        // says done.
        if (s.buffered > chunkSize) {
          const id = s.produced++;
          s.chunks.put(id, { data: take(s, chunkSize), done: false });
          continue;
        }
        let next: IteratorResult<Uint8Array>;
        try {
          next = await s.source.next();
        } catch (e) {
          // What came before the failure is still served.
          while (s.buffered > 0) {
            const id = s.produced++;
            s.chunks.put(id, { data: take(s, Math.min(chunkSize, s.buffered)), done: false });
          }
          s.error = e;
          s.chunks.fail(e);
          return;
        }
        if (next.done) {
          while (s.buffered > chunkSize) {
            const id = s.produced++;
            s.chunks.put(id, { data: take(s, chunkSize), done: false });
          }
          const id = s.produced++;
          s.chunks.put(id, { data: s.buffered ? take(s, s.buffered) : EMPTY, done: true });
          s.ended = true;
          s.chunks.settleFrom(s.produced, () => ({ data: EMPTY, done: true }));
          return;
        }
        let part: Uint8Array;
        try {
          part = toBytes(next.value);
        } catch {
          s.error = new FilesRpcError("INVALID", "the source yielded something that is not bytes");
          s.chunks.fail(s.error);
          return;
        }
        if (part.length) {
          s.buffer.push(part);
          s.buffered += part.length;
        }
      }
    })();
    s.pumping = run;
    // A chunk asked while the loop was ending is produced by the next round.
    void run.finally(() => {
      s.pumping = undefined;
      if (wanted(s)) void pump(s);
    });
    return run;
  };

  const closeSource = async (s: ReadStream) => {
    s.closed = true;
    s.chunks.fail(new FilesRpcError("UNKNOWN_STREAM", "the stream was closed"));
    // Waits for a pull in progress, then ends the source (its finally blocks run).
    await s.pumping?.catch(() => {});
    await Promise.resolve(s.source.return?.()).catch(() => {});
  };

  // ---- writes ----

  /** The chunks of a write stream in order, as they arrive: what the FilesApi's write consumes. */
  async function* ordered(s: WriteStream): AsyncGenerator<Uint8Array> {
    for (;;) {
      s.touched = now(); // the file system took the last chunk: the stream is in use
      if (s.failure !== undefined) throw s.failure;
      const chunk = s.chunks.get(s.next);
      if (chunk) {
        s.chunks.delete(s.next);
        s.next++;
        for (const r of s.room.filter((r) => r.chunkId < s.next + writeWindow)) {
          s.room.splice(s.room.indexOf(r), 1);
          r.resolve();
        }
        yield chunk;
        continue;
      }
      if (s.total !== undefined && s.next >= s.total) return;
      await new Promise<void>((resolve) => {
        s.wake = resolve;
      });
      s.wake = undefined;
    }
  }

  /**
   * Appends `content` to `path`: through the FilesApi's own `append`, or with read, write and
   * remove only. The emulation never reads and writes one path at once (a FilesApi may truncate a
   * file when a write starts): old content and new chunks go to a temporary sibling, which is then
   * written back over the file. It is not atomic against other writers of the file.
   */
  const append = async (
    path: string,
    content: AsyncIterable<Uint8Array>,
    id: string,
  ): Promise<void> => {
    const own = (fs as Partial<AppendableFilesApi>).append;
    if (typeof own === "function") return own.call(fs, path, content);
    const st = await fs.stats(path);
    if (st?.kind === "directory")
      throw new FilesRpcError("INVALID", `cannot append to a directory: ${path}`);
    if (!st) return fs.write(path, content);
    const slash = path.lastIndexOf("/");
    const temp = `${path.slice(0, slash + 1)}.${path.slice(slash + 1)}.append-${id}`;
    try {
      await fs.write(
        temp,
        (async function* () {
          yield* fs.read(path);
          yield* content;
        })(),
      );
      await fs.write(path, fs.read(temp));
    } finally {
      await fs.remove(temp).catch(() => {});
    }
  };

  const failWrite = (s: WriteStream, failure: unknown) => {
    s.failure ??= failure;
    for (const r of s.room.splice(0)) r.reject(s.failure);
    s.wake?.();
  };

  const server: FilesRpcServer = {
    async stats(path) {
      return fs.stats(path);
    },
    async exists(path) {
      return fs.exists(path);
    },
    async mkdir(path) {
      await fs.mkdir(path);
    },
    async remove(path) {
      return fs.remove(path);
    },
    async move(source, target) {
      return fs.move(source, target);
    },
    async copy(source, target) {
      return fs.copy(source, target);
    },
    async list(path, opts = {}): Promise<ListPage> {
      const limit = Math.min(
        Math.max(1, Math.floor(Number(opts.limit) || maxPageSize)),
        maxPageSize,
      );
      const entries: FileInfo[] = [];
      let more = false;
      const after = opts.after;
      for await (const entry of fs.list(path, { recursive: !!opts.recursive, after })) {
        // `after` is applied here too: a FilesApi that ignores it must not make pages repeat.
        if (after !== undefined && comparePaths(entry.path, after) <= 0) continue;
        if (entries.length === limit) {
          more = true;
          break;
        }
        entries.push({ ...entry });
      }
      return { entries, more };
    },

    async openRead(path, opts: OpenReadOptions = {}) {
      const { id, existing } = claim(opts, "read");
      if (existing) return { streamId: id };
      const length = opts.length;
      const source =
        length === 0
          ? (async function* () {})()
          : fs.read(path, { start: opts.start, length })[Symbol.asyncIterator]();
      streams.set(id, {
        kind: "read",
        touched: now(),
        busy: 0,
        source,
        chunks: new Keyed<ReadResult>(),
        buffer: [],
        buffered: 0,
        produced: 0,
        low: 0,
        delivered: new Set(),
        asked: 0,
        released: 0,
        ended: false,
        closed: false,
      });
      return { streamId: id };
    },

    async readChunk(streamId, chunkIdArg) {
      const s = stream(streamId, "read");
      const chunkId = chunkIdOf(chunkIdArg);
      if (chunkId >= s.low + window)
        throw new FilesRpcError(
          "INVALID",
          `chunk ${chunkId} is more than ${window} chunks past the lowest undelivered (${s.low})`,
        );
      // Behind the release line, a chunk is gone once it was delivered; one nobody received yet
      // (asked out of order, or still to be produced) is still served.
      if (chunkId < s.released && chunkId < s.produced && !s.chunks.has(chunkId))
        throw new FilesRpcError(
          "CHUNK_RELEASED",
          `chunk ${chunkId} of '${streamId}' was released (the reader moved past it)`,
        );
      if (chunkId > s.asked) {
        s.asked = chunkId;
        // Chunks `retain` behind the highest asked are not asked again: release the delivered.
        // (At most `window` steps: `asked` stays within the window.)
        const keepFrom = s.asked - retain + 1;
        for (; s.released < keepFrom; s.released++) {
          if (s.released < s.low || s.delivered.has(s.released)) s.chunks.delete(s.released);
        }
      }
      if (s.ended && chunkId >= s.produced) return { data: EMPTY, done: true };
      return busy(s, async () => {
        const answer = s.chunks.wait(chunkId);
        void pump(s);
        const result = await answer;
        // Delivered: the lowest undelivered chunk moves up over every delivered one.
        if (chunkId === s.low) {
          s.low++;
          while (s.delivered.delete(s.low)) s.low++;
        } else if (chunkId > s.low) s.delivered.add(chunkId);
        if (chunkId < s.released) s.chunks.delete(chunkId);
        return result;
      });
    },

    async closeRead(streamId) {
      const s = streams.get(String(streamId));
      if (s?.kind !== "read") return;
      finish(String(streamId));
      await closeSource(s);
    },

    async openWrite(path, opts: OpenWriteOptions = {}) {
      const { id, existing } = claim(opts, "write");
      if (existing) return { streamId: id };
      const s: WriteStream = {
        kind: "write",
        touched: now(),
        busy: 0,
        chunks: new Map(),
        next: 0,
        room: [],
        done: Promise.resolve(),
      };
      s.done = (opts.append ? append(path, ordered(s), id) : fs.write(path, ordered(s))).then(
        () => {
          if (s.failure !== undefined) throw s.failure;
        },
        (e) => {
          failWrite(s, e);
          throw s.failure;
        },
      );
      // Settled by closeWrite (or nobody, after an abort): never an unhandled rejection. A
      // failed stream stays until closed, aborted or swept, so its next call gets the failure.
      s.done.catch(() => {});
      streams.set(id, s);
      return { streamId: id };
    },

    async writeChunk(streamId, chunkIdArg, data) {
      const s = stream(streamId, "write");
      const chunkId = chunkIdOf(chunkIdArg);
      const bytes = toBytes(data);
      if (bytes.length > maxChunkSize)
        throw new FilesRpcError("INVALID", `a chunk is at most ${maxChunkSize} bytes`);
      if (s.failure !== undefined) throw s.failure;
      if (s.total !== undefined && chunkId >= s.total)
        throw new FilesRpcError(
          "INVALID",
          `chunk ${chunkId} is past the stream's ${s.total} chunks`,
        );
      // Delivered twice: already written, or already kept.
      if (chunkId < s.next || s.chunks.has(chunkId)) return;
      // At most one window kept and one waiting for room: what a writer can make the server hold.
      if (chunkId >= s.next + 2 * writeWindow)
        throw new FilesRpcError(
          "INVALID",
          `chunk ${chunkId} is more than ${2 * writeWindow} chunks past the next to write (${s.next})`,
        );
      if (chunkId >= s.next + writeWindow) {
        await busy(
          s,
          () => new Promise<void>((resolve, reject) => s.room.push({ chunkId, resolve, reject })),
        );
        if (chunkId < s.next || s.chunks.has(chunkId)) return;
      }
      // A copy: the caller's buffer may be reused, and a view of a larger buffer is cut out.
      s.chunks.set(chunkId, bytes.slice());
      if (chunkId === s.next) s.wake?.();
    },

    async closeWrite(streamId, chunksArg) {
      const id = String(streamId);
      const done = ended.get(id);
      if (done && !streams.has(id)) {
        if (done.failure !== undefined) throw done.failure;
        return;
      }
      const s = stream(id, "write");
      const total = chunkIdOf(chunksArg);
      const highest = Math.max(s.next - 1, ...s.chunks.keys());
      if (highest >= total) {
        const error = new FilesRpcError(
          "INVALID",
          `the stream has chunk ${highest}, so more than ${total} chunks`,
        );
        failWrite(s, error);
        finish(id, error);
        throw error;
      }
      s.total = total;
      // A chunk waiting for room past the count will never be written.
      for (const r of s.room.filter((r) => r.chunkId >= total)) {
        s.room.splice(s.room.indexOf(r), 1);
        r.reject(
          new FilesRpcError("INVALID", `chunk ${r.chunkId} is past the stream's ${total} chunks`),
        );
      }
      s.wake?.();
      try {
        await busy(s, () => s.done);
        if (streams.get(id) === s) finish(id);
      } catch (e) {
        if (streams.get(id) === s) finish(id, e);
        throw e;
      }
    },

    async abortWrite(streamId, reason) {
      const id = String(streamId);
      const s = streams.get(id);
      if (s?.kind !== "write") return;
      // Every chunk was handed to the FilesApi: the commit is under way; an abort is too late.
      if (s.total !== undefined && s.next >= s.total) return;
      const error = new FilesRpcError("ABORTED", reason ? String(reason) : "the write was aborted");
      finish(id, error);
      failWrite(s, error);
    },

    sweep() {
      const t = now();
      let dropped = 0;
      for (const [id, s] of [...streams]) {
        if (t - s.touched <= idleTimeout) continue;
        // Busy: the file system is working for it. A write whose calls only wait for the holder's
        // next chunk (waiting for room, or closeWrite waiting for a missing chunk) is idle.
        if (s.kind === "read" && s.busy > 0) continue;
        if (
          s.kind === "write" &&
          (s.chunks.has(s.next) || (s.total !== undefined && s.next >= s.total))
        )
          continue;
        dropped++;
        const error = new FilesRpcError("ABORTED", "the stream was idle too long");
        finish(id, error);
        if (s.kind === "read") void closeSource(s);
        else failWrite(s, error);
      }
      for (const [id, e] of [...ended]) if (t - e.at > idleTimeout) ended.delete(id);
      return dropped;
    },

    openStreams() {
      return streams.size;
    },

    async close() {
      if (timer) clearInterval(timer);
      const sources: Promise<unknown>[] = [];
      for (const [id, s] of [...streams]) {
        const error = new FilesRpcError("ABORTED", "the server closed");
        finish(id, error);
        if (s.kind === "read") sources.push(closeSource(s));
        else failWrite(s, error); // not awaited: a FilesApi write may never settle
      }
      await Promise.race([
        Promise.all(sources),
        new Promise((r) => {
          const t = setTimeout(r, 1000);
          (t as { unref?: () => void }).unref?.();
        }),
      ]);
    },
  };
  const timer =
    options.sweepInterval && options.sweepInterval > 0
      ? setInterval(() => server.sweep(), options.sweepInterval)
      : undefined;
  (timer as { unref?: () => void } | undefined)?.unref?.();
  return server;
}
