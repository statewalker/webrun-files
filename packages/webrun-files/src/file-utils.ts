import type { FilesApi } from "./types.js";

/**
 * Collect async iterable chunks into a single Uint8Array.
 */
async function collectChunks(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let totalLength = 0;
  for await (const chunk of chunks) {
    parts.push(chunk);
    totalLength += chunk.length;
  }
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0];
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of parts) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Read entire file content into a Uint8Array.
 * Returns empty array if file doesn't exist.
 */
export async function readFile(files: FilesApi, path: string): Promise<Uint8Array> {
  return collectChunks(files.read(path));
}

/**
 * Read entire file content as a UTF-8 string.
 * Returns empty string if file doesn't exist.
 */
export async function readText(files: FilesApi, path: string): Promise<string> {
  const data = await readFile(files, path);
  return new TextDecoder().decode(data);
}

/**
 * Read file content, returning undefined if file doesn't exist.
 */
export async function tryReadFile(files: FilesApi, path: string): Promise<Uint8Array | undefined> {
  if (!(await files.exists(path))) return undefined;
  return readFile(files, path);
}

/**
 * Read file content as string, returning undefined if file doesn't exist.
 */
export async function tryReadText(files: FilesApi, path: string): Promise<string | undefined> {
  const data = await tryReadFile(files, path);
  return data ? new TextDecoder().decode(data) : undefined;
}

/**
 * Read a specific byte range from a file.
 *
 * @param files - FilesApi instance
 * @param path - File path
 * @param position - Starting byte position
 * @param length - Number of bytes to read
 * @returns Uint8Array with requested bytes (may be shorter if EOF reached)
 */
export async function readRange(
  files: FilesApi,
  path: string,
  position: number,
  length: number,
): Promise<Uint8Array> {
  return collectChunks(files.read(path, { start: position, length }));
}

/**
 * Read bytes from a file into a buffer at a specific offset.
 * Similar to Node.js fs.read() signature.
 *
 * @param files - FilesApi instance
 * @param path - File path
 * @param buffer - Target buffer to write into
 * @param bufferOffset - Offset in buffer where to start writing
 * @param length - Number of bytes to read
 * @param position - Position in file where to start reading
 * @returns Number of bytes actually read
 */
export async function readAt(
  files: FilesApi,
  path: string,
  buffer: Uint8Array,
  bufferOffset: number,
  length: number,
  position: number,
): Promise<number> {
  const data = await readRange(files, path, position, length);
  const bytesToCopy = Math.min(data.length, buffer.length - bufferOffset);
  buffer.set(data.subarray(0, bytesToCopy), bufferOffset);
  return bytesToCopy;
}

/**
 * Write a string to a file as UTF-8.
 */
export async function writeText(files: FilesApi, path: string, content: string): Promise<void> {
  await files.write(path, [new TextEncoder().encode(content)]);
}
