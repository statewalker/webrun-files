import type { FilesApi, ReadOptions } from "@statewalker/webrun-files";
import type { FilesRpc } from "../src/index.js";

/** `n` deterministic bytes from `seed`. */
export function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of it) parts.push(p);
  return concat(parts);
}

export const text = (s: string) => new TextEncoder().encode(s);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A FilesApi whose reads are counted chunk by chunk (to see how far ahead a server pulls). */
export function countingFs(fs: FilesApi, chunk = 1000) {
  const stats = { pulled: 0, returned: 0, writes: 0 };
  const wrapped: FilesApi = Object.create(fs);
  wrapped.read = async function* (path: string, options?: ReadOptions) {
    try {
      for await (const part of fs.read(path, options)) {
        for (let at = 0; at < part.length; at += chunk) {
          stats.pulled++;
          yield part.subarray(at, at + chunk);
        }
      }
    } finally {
      stats.returned++;
    }
  };
  wrapped.write = async (path, content) => {
    stats.writes++;
    return fs.write(path, content);
  };
  return { fs: wrapped, stats };
}

/** A Promise that can be resolved from outside. */
export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((ok, ko) => {
    resolve = ok;
    reject = ko;
  });
  return { promise, resolve, reject };
}

/**
 * An RPC transport between a client and a server: arguments and results are structured-cloned
 * (as postMessage and Durable Object RPC do), calls may be delayed by random amounts (so they
 * arrive and complete out of order), and may be delivered twice (a retry).
 */
export function transport(
  server: FilesRpc,
  options: {
    maxDelay?: number;
    duplicate?: number;
    seed?: number;
    /** The methods that may be delivered twice (default: all). */
    duplicated?: (method: string) => boolean;
  } = {},
) {
  let x = options.seed ?? 7;
  const rnd = () => {
    x = (x * 1103515245 + 12345) >>> 0;
    return x / 2 ** 32;
  };
  const calls: { method: string; args: unknown[] }[] = [];
  const delay = () => sleep(Math.floor(rnd() * (options.maxDelay ?? 0)));
  const rpc = new Proxy({} as FilesRpc, {
    get(_, method: string) {
      return async (...args: unknown[]) => {
        calls.push({ method, args });
        const sent = structuredClone(args);
        await delay();
        // biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch in a test transport
        const call = () => (server as any)[method](...structuredClone(sent));
        if (rnd() < (options.duplicate ?? 0) && (options.duplicated?.(method) ?? true)) {
          // The same call delivered twice: once more, concurrently, its result discarded.
          void call().catch(() => {});
        }
        const result = await call();
        await delay();
        return structuredClone(result);
      };
    },
  });
  return { rpc, calls };
}
