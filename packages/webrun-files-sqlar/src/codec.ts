/**
 * SQLAR compression.
 *
 * The format mandates zlib-wrapped Deflate (RFC 1950, the `78 xx` header) —
 * what zlib's `compress()` writes. Every codec here writes exactly that, so an
 * archive written by one is read by any other, and by other SQLAR tools.
 */
export interface Codec {
  name: string;
  /**
   * Inputs shorter than this are stored plaintext without a deflate attempt:
   * deflating a short input makes it longer.
   */
  minSize: number;
  deflate(bytes: Uint8Array): Uint8Array | Promise<Uint8Array>;
  inflate(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

const MIN_SIZE = 64;

/** Compression Streams — browsers, Node, Workers. No dependency. */
export function webCodec(opts: { minSize?: number } = {}): Codec {
  if (typeof CompressionStream === "undefined") {
    throw new Error("webCodec: CompressionStream is not available in this runtime");
  }
  return {
    name: "web",
    minSize: opts.minSize ?? MIN_SIZE,
    // "deflate" is the zlib-wrapped format; "deflate-raw" would not be SQLAR.
    deflate: (bytes) => pipe(bytes, new CompressionStream("deflate")),
    inflate: (data) => pipe(data, new DecompressionStream("deflate")),
  };
}

/** The part of the `pako` module this codec uses. */
export interface PakoModule {
  deflate(data: Uint8Array, opts?: { level?: number }): Uint8Array;
  inflate(data: Uint8Array): Uint8Array;
}

/**
 * pako — synchronous, for runtimes without a usable CompressionStream. The
 * module is injected so this package does not depend on it:
 *
 *     import * as pako from "pako";
 *     new SqlarFilesApi(driver, { codec: pakoCodec(pako) });
 */
export function pakoCodec(
  pako: PakoModule,
  opts: { minSize?: number; level?: number } = {},
): Codec {
  const deflateOptions = opts.level === undefined ? {} : { level: opts.level };
  return {
    name: "pako",
    minSize: opts.minSize ?? MIN_SIZE,
    // pako.deflate is zlib-wrapped by default; deflateRaw is not.
    deflate: (bytes) => pako.deflate(bytes, deflateOptions),
    inflate: (data) => pako.inflate(data),
  };
}

/**
 * No compression — still a valid archive. Reading a compressed row through it
 * throws rather than returning deflate bytes as file content.
 */
export function rawCodec(): Codec {
  return {
    name: "raw",
    minSize: Number.POSITIVE_INFINITY,
    deflate: (bytes) => bytes,
    inflate() {
      throw new Error("rawCodec cannot inflate: this archive holds compressed rows");
    },
  };
}

/** webCodec where CompressionStream exists, rawCodec elsewhere. */
export function defaultCodec(): Codec {
  return typeof CompressionStream === "undefined" ? rawCodec() : webCodec();
}

async function pipe(
  bytes: Uint8Array,
  transform: TransformStream<BufferSource, Uint8Array>,
): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
