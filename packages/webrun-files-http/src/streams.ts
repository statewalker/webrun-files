/**
 * Bridges between `(Async)Iterable<Uint8Array>` and `ReadableStream`, both
 * pull-driven: nothing is read from a source until the other side asks for
 * it, and stopping one side closes the other.
 */

/** A stream that takes one chunk from `source` per `pull`, and returns the iterator on cancel. */
export function toStream(
  source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  let iterator: AsyncIterator<Uint8Array> | Iterator<Uint8Array> | undefined;
  const open = () => {
    iterator ??=
      Symbol.asyncIterator in source
        ? source[Symbol.asyncIterator]()
        : (source as Iterable<Uint8Array>)[Symbol.iterator]();
    return iterator;
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await open().next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel(reason) {
        await iterator?.return?.(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/** Iterate a stream's chunks; stopping early cancels the stream. */
export async function* fromStream(
  stream: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array> {
  if (!stream) return;
  const reader = stream.getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
