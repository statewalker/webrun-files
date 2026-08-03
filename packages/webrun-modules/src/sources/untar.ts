import { gunzipSync } from "fflate";

/**
 * Untar an npm `.tgz` (gzipped ustar) into a map of path → bytes, isomorphically
 * (no `node:zlib`, no `Buffer`). npm tarballs prefix every entry with `package/`;
 * that prefix is stripped so keys are relative to the package root.
 */
export function untarTgz(tgz: Uint8Array): Map<string, Uint8Array> {
  return untar(gunzipSync(tgz));
}

const td = new TextDecoder();

function str(buf: Uint8Array, start: number, end: number): string {
  return td.decode(buf.subarray(start, end)).replace(/\0.*/s, "");
}

/** Parse a raw ustar archive (512-byte blocks). */
export function untar(buf: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = str(buf, off, off + 100);
    if (!name) break; // two zero blocks terminate the archive
    const size = Number.parseInt(str(buf, off + 124, off + 136).trim() || "0", 8);
    const type = str(buf, off + 156, off + 157);
    const prefix = str(buf, off + 345, off + 500);
    const full = prefix ? `${prefix}/${name}` : name;
    const start = off + 512;
    // type "0" or "" = regular file; skip directories/links/pax headers.
    if (type === "0" || type === "") {
      out.set(full.replace(/^package\//, ""), buf.subarray(start, start + size));
    }
    off = start + Math.ceil(size / 512) * 512;
  }
  return out;
}
