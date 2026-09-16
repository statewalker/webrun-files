/**
 * Pull bytes from a chunk source in bounded pieces.
 *
 * `read(max)` hands out at most `max` bytes as a zero-copy view of the current
 * source chunk, and pulls the next chunk only when the current one is spent.
 * The source is therefore never read ahead of its consumer: this is the
 * backpressure boundary between a caller's stream and block storage.
 */
export class ByteReader {
  readonly #iterator: AsyncIterator<Uint8Array> | Iterator<Uint8Array>;
  #chunk: Uint8Array | undefined;
  #done = false;

  constructor(source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) {
    this.#iterator =
      Symbol.asyncIterator in source
        ? source[Symbol.asyncIterator]()
        : (source as Iterable<Uint8Array>)[Symbol.iterator]();
  }

  /** At most `max` bytes, or `undefined` once the source is exhausted. */
  async read(max: number): Promise<Uint8Array | undefined> {
    while (!this.#chunk || this.#chunk.length === 0) {
      if (this.#done) return undefined;
      const next = await this.#iterator.next();
      if (next.done) {
        this.#done = true;
        this.#chunk = undefined;
        return undefined;
      }
      this.#chunk = next.value;
    }
    const piece = this.#chunk.subarray(0, max);
    this.#chunk = this.#chunk.subarray(piece.length);
    return piece;
  }

  /** Release the source early, as `break` in a `for await` would. */
  async close(): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    this.#chunk = undefined;
    await this.#iterator.return?.();
  }
}

/** One Uint8Array from a stream's chunks — only ever used on a single block's worth. */
export async function collectBlock(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    parts.push(chunk);
    total += chunk.length;
  }
  // Always a copy: a piece may be a view into a caller's buffer, which a binding
  // could read whole and a caller could reuse once we pull again.
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
