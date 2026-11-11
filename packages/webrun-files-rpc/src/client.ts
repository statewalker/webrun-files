import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import type { FilesRpc, ReadResult } from "./types.js";

export interface FilesRpcClientOptions {
  /** The server's methods, through any transport (a stub, a proxy, the server itself). */
  rpc: FilesRpc;
  /** Bytes per chunk written. Default 256 KiB (keep it at most the server's `maxChunkSize`). */
  chunkSize?: number;
  /** Chunk requests kept in flight while reading. Default 4 (below the server's `window`). */
  readAhead?: number;
  /** Chunks sent and not yet acknowledged while writing. Default 4. */
  writeAhead?: number;
  /** Listing page size. Default 256. */
  pageSize?: number;
}

const toBytes = (v: unknown): Uint8Array =>
  v instanceof Uint8Array
    ? v
    : ArrayBuffer.isView(v)
      ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
      : new Uint8Array(v as ArrayBuffer);

const newStreamId = () => crypto.randomUUID().replace(/-/g, "");

/** Cuts any sequence of byte arrays into chunks of exactly `size` bytes (the last may be shorter). */
async function* rechunk(
  content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  size: number,
): AsyncGenerator<Uint8Array> {
  let carry: Uint8Array | undefined;
  let carried = 0;
  for await (const piece of content as AsyncIterable<Uint8Array>) {
    let part = toBytes(piece);
    while (part.length) {
      if (!carry && part.length >= size) {
        yield part.slice(0, size);
        part = part.subarray(size);
        continue;
      }
      carry ??= new Uint8Array(size);
      const n = Math.min(size - carried, part.length);
      carry.set(part.subarray(0, n), carried);
      carried += n;
      part = part.subarray(n);
      if (carried === size) {
        yield carry;
        carry = undefined;
        carried = 0;
      }
    }
  }
  if (carry && carried) yield carry.slice(0, carried);
}

/** A FilesApi whose every call goes through a FilesRpc; content moves in keyed chunks. */
export class FilesRpcClient implements FilesApi {
  #rpc: FilesRpc;
  #chunkSize: number;
  #readAhead: number;
  #writeAhead: number;
  #pageSize: number;

  constructor(options: FilesRpcClientOptions) {
    this.#rpc = options.rpc;
    this.#chunkSize = Math.max(1, options.chunkSize ?? 256 * 1024);
    this.#readAhead = Math.max(1, options.readAhead ?? 4);
    this.#writeAhead = Math.max(1, options.writeAhead ?? 4);
    this.#pageSize = Math.max(1, options.pageSize ?? 256);
  }

  /**
   * Asks for chunks 0, 1, 2, … keeping `readAhead` requests in flight, and yields them in key
   * order whatever order the answers come in.
   */
  async *read(path: string, options: ReadOptions = {}): AsyncIterable<Uint8Array> {
    const { start, length, signal } = options;
    if (length === 0) return;
    signal?.throwIfAborted();
    const { streamId } = await this.#rpc.openRead(path, {
      start,
      length,
      streamId: newStreamId(),
    });
    const pending = new Map<number, Promise<ReadResult>>();
    // An abort interrupts the wait for an answer, not only the loop between answers.
    const aborted = signal
      ? new Promise<never>((_, reject) => {
          const fail = () => reject(signal.reason ?? new Error("aborted"));
          if (signal.aborted) fail();
          else signal.addEventListener("abort", fail, { once: true });
        })
      : undefined;
    aborted?.catch(() => {});
    let asked = 0;
    let finished = false;
    try {
      for (let next = 0; ; next++) {
        while (!finished && asked < next + this.#readAhead) {
          const request = this.#rpc.readChunk(streamId, asked);
          request.catch(() => {}); // awaited below, in order
          pending.set(asked++, request);
        }
        const answer = pending.get(next) as Promise<ReadResult>;
        pending.delete(next);
        const { data, done } = await (aborted ? Promise.race([answer, aborted]) : answer);
        signal?.throwIfAborted();
        if (done) finished = true;
        const bytes = toBytes(data);
        if (bytes.length) yield bytes;
        if (done) return;
        signal?.throwIfAborted();
      }
    } finally {
      await this.#rpc.closeRead(streamId).catch(() => {});
    }
  }

  /**
   * Sends chunks of `chunkSize` bytes keyed 0, 1, 2, … with up to `writeAhead` unacknowledged,
   * then `closeWrite` with their count; any failure aborts the write.
   */
  async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const { streamId } = await this.#rpc.openWrite(path, { streamId: newStreamId() });
    const inFlight = new Set<Promise<void>>();
    let failure: { error: unknown } | undefined;
    let count = 0;
    try {
      for await (const chunk of rechunk(content, this.#chunkSize)) {
        if (failure) throw failure.error;
        const sent: Promise<void> = this.#rpc.writeChunk(streamId, count++, chunk).then(
          () => {
            inFlight.delete(sent);
          },
          (error) => {
            inFlight.delete(sent);
            failure ??= { error };
          },
        );
        inFlight.add(sent);
        while (inFlight.size >= this.#writeAhead) await Promise.race(inFlight);
      }
      await Promise.all(inFlight);
      if (failure) throw failure.error;
      await this.#rpc.closeWrite(streamId, count);
    } catch (e) {
      await this.#rpc.abortWrite(streamId, String((e as Error)?.message ?? e)).catch(() => {});
      throw e;
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.#rpc.mkdir(path);
  }

  /** Pages of `pageSize`, each asked after the last path of the one before. */
  async *list(path: string, options: ListOptions = {}): AsyncIterable<FileInfo> {
    let after = options.after;
    for (;;) {
      const page = await this.#rpc.list(path, {
        recursive: options.recursive,
        after,
        limit: this.#pageSize,
      });
      yield* page.entries;
      if (!page.more || page.entries.length === 0) return;
      after = page.entries[page.entries.length - 1]?.path;
    }
  }

  stats(path: string): Promise<FileStats | undefined> {
    return this.#rpc.stats(path);
  }
  exists(path: string): Promise<boolean> {
    return this.#rpc.exists(path);
  }
  remove(path: string): Promise<boolean> {
    return this.#rpc.remove(path);
  }
  move(source: string, target: string): Promise<boolean> {
    return this.#rpc.move(source, target);
  }
  copy(source: string, target: string): Promise<boolean> {
    return this.#rpc.copy(source, target);
  }
}

/** A FilesApi over a FilesRpc. */
export function newFilesRpcClient(options: FilesRpcClientOptions): FilesRpcClient {
  return new FilesRpcClient(options);
}
