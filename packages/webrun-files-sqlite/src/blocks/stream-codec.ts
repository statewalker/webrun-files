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
