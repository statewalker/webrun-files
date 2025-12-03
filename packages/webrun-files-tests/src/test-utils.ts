/**
 * Test utilities for IFilesApi implementations
 */

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
