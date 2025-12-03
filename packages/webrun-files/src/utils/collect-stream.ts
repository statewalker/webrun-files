/**
 * Stream collection utilities
 */

/**
 * Collects all values from an async generator into an array.
 */
export async function collectGenerator<T>(generator: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of generator) {
    results.push(item);
  }
  return results;
}

/**
 * Converts a synchronous iterable to an async iterable.
 */
export async function* toAsyncIterable<T>(iterable: Iterable<T>): AsyncIterable<T> {
  for (const item of iterable) {
    yield item;
  }
}

/**
 * Normalizes BinaryStream to AsyncIterable<Uint8Array>.
 */
export function toBinaryAsyncIterable(
  data: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in data) {
    return data as AsyncIterable<Uint8Array>;
  }
  return toAsyncIterable(data as Iterable<Uint8Array>);
}
