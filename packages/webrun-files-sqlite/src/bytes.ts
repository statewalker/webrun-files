/** BLOBs arrive as Uint8Array from every @statewalker/db-sqlite driver; SQLAR may hold TEXT. */
export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new Uint8Array(0);
}
