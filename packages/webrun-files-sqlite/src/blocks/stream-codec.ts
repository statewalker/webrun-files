/**
 * A streaming compression format. Pulled, never pushed: `compress` and
 * `decompress` read their input only as their output is consumed.
 */
export interface StreamCodec {
  /** Stored in `fs_files.compression`. Implementations of one format share the name. */
  name: string;
  compress(input: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>;
  decompress(input: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>;
}

/**
 * zlib-wrapped Deflate over Compression Streams — browsers, Node, Deno, Bun,
 * Workers. The source is wrapped in a pull-only ReadableStream, so the
 * transform asks for input only when it has room, and cancelling the output
 * closes the source.
 */
export function webDeflateCodec(): StreamCodec {
  if (typeof CompressionStream === "undefined") {
    throw new Error("webDeflateCodec: CompressionStream is not available in this runtime");
  }
  return {
    name: "deflate",
    compress: (input) =>
      iterate(pullStream(input).pipeThrough(asPair(new CompressionStream("deflate")))),
    decompress: (input) =>
      iterate(pullStream(input).pipeThrough(asPair(new DecompressionStream("deflate")))),
  };
}

/** The part of the `pako` module the streaming codec uses. */
export interface PakoStreamModule {
  Deflate: new (options?: { level?: number }) => PakoStream;
  Inflate: new () => PakoStream;
}

interface PakoStream {
  push(data: Uint8Array, flush?: boolean): boolean;
  onData(chunk: Uint8Array): void;
  err: number;
  msg: string;
  ended?: boolean;
}

/**
 * zlib-wrapped Deflate through pako's incremental classes, for runtimes without
 * Compression Streams. The module is injected, not imported.
 */
export function pakoDeflateCodec(
  pako: PakoStreamModule,
  opts: { level?: number } = {},
): StreamCodec {
  const options = opts.level === undefined ? {} : { level: opts.level };
  return {
    name: "deflate",
    compress: (input) => pakoTransform(new pako.Deflate(options), input, true),
    decompress: (input) => pakoTransform(new pako.Inflate(), input, false),
  };
}

/**
 * Feed one input chunk at a time and hand on whatever that produced before
 * pulling again. pako's `push` is synchronous, so its output per chunk is
 * bounded by the chunk.
 */
async function* pakoTransform(
  stream: PakoStream,
  input: AsyncIterable<Uint8Array>,
  compressing: boolean,
): AsyncGenerator<Uint8Array> {
  let pending: Uint8Array[] = [];
  stream.onData = (chunk) => pending.push(chunk);
  const check = () => {
    if (stream.err) throw new Error(`pako: ${stream.msg || `error ${stream.err}`}`);
  };
  for await (const chunk of input) {
    if (chunk.length === 0) continue;
    stream.push(chunk, false);
    check();
    const out = pending;
    pending = [];
    yield* out;
  }
  if (compressing) {
    stream.push(new Uint8Array(0), true);
    check();
  } else if (!stream.ended) {
    throw new Error("pako: truncated deflate stream");
  }
  yield* pending;
}

/** Compression streams accept any BufferSource; this pipe only ever writes Uint8Array. */
function asPair(transform: CompressionStream | DecompressionStream) {
  return transform as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
}

function pullStream(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel(reason) {
        await iterator.return?.(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

async function* iterate(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
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
    // An early exit cancels the pipeline, which closes the source.
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
