/**
 * Test utilities for IFilesApi implementations
 */

import type { FileEntryStats, FileInfo, FileStats } from "@statewalker/webrun-files";

/**
 * Narrow a `stats()` result to the file variant, failing loudly when it is
 * anything else.
 *
 * `size` and `lastModified` live on the file variant of `FileStats` alone, so
 * a test that wants either has to say which variant it expects. Doing that
 * through this helper keeps the failure legible: "expected a file, got a
 * directory" rather than a comparison against `undefined`.
 */
export function asFileStats(stats: FileStats | FileInfo | undefined): FileEntryStats {
  if (stats === undefined) {
    throw new Error("expected the file variant of FileStats, got undefined");
  }
  if (stats.kind !== "file") {
    throw new Error(`expected the file variant of FileStats, got a ${stats.kind}`);
  }
  return stats;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

export function decode(data: Uint8Array): string {
  return decoder.decode(data);
}

export function toBytes(str: string): Uint8Array {
  return encode(str);
}

export function fromBytes(bytes: Uint8Array): string {
  return decode(bytes);
}

export function allBytesContent(): Uint8Array {
  const content = new Uint8Array(256);
  for (let i = 0; i < 256; i++) content[i] = i;
  return content;
}

export function patternContent(size: number, seed: number = 0): Uint8Array {
  const content = new Uint8Array(size);
  for (let i = 0; i < size; i++) content[i] = (i + seed) % 256;
  return content;
}

export function randomBytes(size: number): Uint8Array {
  const buffer = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    buffer[i] = Math.floor(Math.random() * 256);
  }
  return buffer;
}

export async function collectStream(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  for await (const chunk of stream) {
    chunks.push(chunk);
    totalLength += chunk.length;
  }

  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function collectGenerator<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of gen) {
    results.push(item);
  }
  return results;
}

/**
 * The byte stored at `position` in the big-file suite's content: the low byte
 * of a 32-bit integer hash of the offset. Cheap, random-access and not
 * compressible, so expected content never has to be held in memory.
 */
export function positionByte(position: number): number {
  let h = position >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) & 0xff;
}

/**
 * Lazily generate `size` bytes of {@link positionByte} content, in chunks
 * whose sizes cycle through `chunkSizes`. Each chunk is created when pulled.
 */
export async function* positionContent(
  size: number,
  chunkSizes: number[] = [64 * 1024],
  start = 0,
): AsyncGenerator<Uint8Array> {
  let position = start;
  const end = start + size;
  for (let i = 0; position < end; i++) {
    const length = Math.min(chunkSizes[i % chunkSizes.length], end - position);
    const chunk = new Uint8Array(length);
    for (let j = 0; j < length; j++) chunk[j] = positionByte(position + j);
    position += length;
    yield chunk;
  }
}
