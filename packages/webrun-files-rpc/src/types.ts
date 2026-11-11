import type { FileInfo, FileStats } from "@statewalker/webrun-files";

/** One chunk of a read stream: its bytes, and whether it is the last. */
export interface ReadResult {
  data: Uint8Array;
  done: boolean;
}

/** One page of a listing. `more`: ask again with `after` = the last path of this page. */
export interface ListPage {
  entries: FileInfo[];
  more: boolean;
}

/** One page of `list`: `after` the given path (exclusive), at most `limit` entries. */
export interface ListPageOptions {
  recursive?: boolean;
  after?: string;
  limit?: number;
}

/** Open options shared by reads and writes. */
export interface OpenOptions {
  /**
   * The stream's id, chosen by the caller (16 to 128 characters of `[A-Za-z0-9_-]`, random:
   * `crypto.randomUUID()`), so that an open delivered twice opens one stream. Without it the
   * server chooses one.
   */
  streamId?: string;
}

export interface OpenReadOptions extends OpenOptions {
  /** First byte (default 0). */
  start?: number;
  /** Bytes to read (default: to the end). */
  length?: number;
}

/**
 * What the server exposes and the client calls: a FilesApi cut into calls an RPC can carry.
 * Every argument and result is a plain value (strings, numbers, booleans, plain objects,
 * Uint8Array), so any transport that passes structured-clonable values carries it: Durable
 * Object and Workers RPC, postMessage, comlink, or a direct call.
 *
 * Content moves as chunks keyed by (streamId, chunkId). chunkId counts from 0 in each stream.
 * Both sides keep chunks by their key and wait for the ones that have not arrived: the server
 * answers `readChunk(id, k)` once chunk k exists, and writes chunk k once chunks 0..k-1 are
 * written, whatever order they came in. Calls delivered twice are harmless.
 */
export interface FilesRpc {
  stats(path: string): Promise<FileStats | undefined>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<boolean>;
  move(source: string, target: string): Promise<boolean>;
  copy(source: string, target: string): Promise<boolean>;
  list(path: string, options?: ListPageOptions): Promise<ListPage>;

  /** Opens `path` for reading. A file that does not exist reads as nothing. */
  openRead(path: string, options?: OpenReadOptions): Promise<{ streamId: string }>;
  /**
   * Chunk `chunkId` of the stream, once it exists. Past the end: empty and done. A chunk can be
   * asked again (a retry) until the reader has moved `retain` chunks past it.
   */
  readChunk(streamId: string, chunkId: number): Promise<ReadResult>;
  /** Ends the stream (unknown or closed: nothing happens). */
  closeRead(streamId: string): Promise<void>;

  /** Opens `path` for writing; the FilesApi's `write` consumes the chunks in order. */
  openWrite(path: string, options?: OpenOptions): Promise<{ streamId: string }>;
  /**
   * Hands over chunk `chunkId`. Resolves once it is kept (not yet written): at once if it is
   * within `writeWindow` chunks of the next to write, else when it is. A chunk already received
   * is ignored.
   */
  writeChunk(streamId: string, chunkId: number, data: Uint8Array | ArrayBuffer): Promise<void>;
  /** The stream had `chunks` chunks: resolves when all of them are written. */
  closeWrite(streamId: string, chunks: number): Promise<void>;
  /** Cancels the write (unknown or closed: nothing happens). */
  abortWrite(streamId: string, reason?: string): Promise<void>;
}

/** Error codes of FilesRpcError. */
export type FilesRpcErrorCode =
  | "UNKNOWN_STREAM"
  | "CHUNK_RELEASED"
  | "TOO_MANY_STREAMS"
  | "ABORTED"
  | "INVALID";
