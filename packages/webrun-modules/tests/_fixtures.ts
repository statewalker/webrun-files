import { gzipSync } from "fflate";

const enc = new TextEncoder();

/** Minimal ustar tar writer for fixtures (files keyed by full path incl. `package/`). */
export function makeTar(files: Record<string, string>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = enc.encode(content);
    const header = new Uint8Array(512);
    header.set(enc.encode(name), 0);
    header.set(enc.encode("0000644"), 100);
    header.set(enc.encode(data.length.toString(8).padStart(11, "0")), 124);
    header.set(enc.encode("00000000000"), 136);
    header[156] = 0x30; // regular file
    header.set(enc.encode("ustar\x0000"), 257);
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\x00 `), 148);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const tar = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    tar.set(b, off);
    off += b.length;
  }
  return tar;
}

export function makeTgz(files: Record<string, string>): Uint8Array {
  return gzipSync(makeTar(files));
}

type Route = { json?: unknown; bytes?: Uint8Array; status?: number };

/** A fake `fetch` that routes by exact URL to canned JSON or bytes. */
export function fakeFetch(routes: Record<string, Route>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const r = routes[url];
    if (!r) return new Response(null, { status: 404 });
    if (r.status && r.status >= 400) return new Response(null, { status: r.status });
    if (r.bytes) return new Response(r.bytes, { status: 200 });
    return new Response(JSON.stringify(r.json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
