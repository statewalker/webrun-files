/** Blobs arrive as Uint8Array (node:sqlite), ArrayBuffer (Durable Objects) or number[] (D1). */
export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new Uint8Array(0);
}
