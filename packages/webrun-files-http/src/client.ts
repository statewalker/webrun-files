import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import { errorFromResponse } from "./errors.js";
import { encodeFilesPath } from "./paths.js";
import { fromStream, toStream } from "./streams.js";
import type { ClientStubOptions, FetchHandler, ServerCapabilities } from "./types.js";

/**
 * A `FilesApi` that sends every call to a server stub over `fetch`. Reads the
 * server's capabilities first, so part and page sizes agree with it.
 */
export async function newClientStub(options: ClientStubOptions): Promise<FilesApi> {
  const fetch: FetchHandler = options.fetch ?? ((req) => globalThis.fetch(req));
  const base = new URL(options.baseUrl);
  base.pathname = base.pathname.replace(/\/+$/, "");
  const send = async (req: Request) =>
    fetch(options.setHeaders ? await options.setHeaders(req) : req);

  const res = await send(new Request(urlFor(base, "/", { capabilities: "" })));
  if (!res.ok) throw await errorFromResponse(res);
  const capabilities = (await res.json()) as ServerCapabilities;

  return new HttpFilesApi(base, send, capabilities, options);
}

class HttpFilesApi implements FilesApi {
  readonly #base: URL;
  readonly #send: FetchHandler;
  readonly #methods: "http" | "post";
  readonly #upload: "stream" | "chunked";
  readonly #partSize: number;
  readonly #pageSize: number;
  readonly #retries: number;
  readonly #maxParts: number;

  constructor(
    base: URL,
    send: FetchHandler,
    capabilities: ServerCapabilities,
    options: ClientStubOptions,
  ) {
    this.#base = base;
    this.#send = send;
    this.#methods = options.methods ?? "http";
    this.#upload =
      options.upload === undefined || options.upload === "auto"
        ? detectUploadMode()
        : options.upload;
    this.#partSize = Math.min(
      options.partSize ?? capabilities.minPartSize,
      capabilities.maxPartSize,
    );
    this.#pageSize = Math.min(
      options.pageSize ?? capabilities.maxPageSize,
      capabilities.maxPageSize,
    );
    this.#retries = options.retries ?? 2;
    this.#maxParts = capabilities.maxParts;
  }

  // ---------------------------------------------------------------- read

  async *read(path: string, options: ReadOptions = {}): AsyncIterable<Uint8Array> {
    const { start, length, signal } = options;
    if (length === 0) return;
    const headers = new Headers();
    if (start !== undefined || length !== undefined) {
      const from = start ?? 0;
      headers.set("Range", `bytes=${from}-${length === undefined ? "" : from + length - 1}`);
    }
    const res = await this.#send(new Request(this.#url(path), { headers, signal }));
    if (res.status === 404 || res.status === 416) {
      await res.body?.cancel();
      return;
    }
    if (!res.ok) throw await errorFromResponse(res);
    yield* fromStream(res.body);
  }

  async stats(path: string): Promise<FileStats | undefined> {
    const res = await this.#send(new Request(this.#url(path), { method: "HEAD" }));
    if (res.status === 404) return undefined;
    if (!res.ok) throw await errorFromResponse(res);
    if (res.headers.get("X-File-Kind") === "directory") return { kind: "directory" };
    return {
      kind: "file",
      size: Number(res.headers.get("X-File-Size")),
      lastModified: Number(res.headers.get("X-Last-Modified-Ms")),
    };
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stats(path)) !== undefined;
  }

  /**
   * One lazy iterator over pages: the next page is fetched only once the
   * consumer has taken every entry of the current one. A failed page is
   * retried after the last entry actually yielded, which ordered listings
   * make exactly-once.
   */
  async *list(path: string, options: ListOptions = {}): AsyncIterable<FileInfo> {
    let after = options.after;
    for (let failures = 0; ; ) {
      let page: { items: FileInfo[]; next?: string };
      try {
        const query: Record<string, string> = { list: "", limit: String(this.#pageSize) };
        if (options.recursive) query.recursive = "1";
        if (after !== undefined) query.after = after;
        const res = await this.#send(new Request(this.#url(path, query)));
        if (!res.ok) throw await errorFromResponse(res);
        page = (await res.json()) as typeof page;
        failures = 0;
      } catch (error) {
        if (failures++ < this.#retries) continue;
        throw error;
      }
      for (const item of page.items) {
        yield item;
        after = item.path;
      }
      if (page.next === undefined) return;
    }
  }

  // --------------------------------------------------------------- write

  async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    if (this.#upload === "stream") {
      // A runtime without request streams does not fail such a request: Firefox
      // sends the text "[object ReadableStream]" as the body, and it is stored.
      if (!supportsRequestStreams()) {
        throw new Error(
          `webrun-files-http: this runtime cannot stream request bodies; use upload "chunked" or "auto" (${path})`,
        );
      }
      const init: RequestInit & { duplex: "half" } = {
        method: "PUT",
        body: toStream(content),
        duplex: "half",
      };
      await this.#expectOk(await this.#send(new Request(this.#url(path), init)));
      return;
    }
    await this.#writeChunked(path, content);
  }

  /**
   * Parts of `partSize` bytes, one in memory at a time. Content that fits in
   * one part is a single plain PUT; otherwise an upload is opened, each part
   * sent as soon as it is full (a retry overwrites the same part number), and
   * the upload completed — or aborted if anything fails.
   */
  async #writeChunked(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const parts = new PartReader(content, this.#partSize);
    let part = await parts.next();
    if (!(await parts.hasMore())) {
      await this.#expectOk(
        await this.#send(new Request(this.#url(path), { method: "PUT", body: part as BodyInit })),
      );
      return;
    }

    const created = await this.#send(
      new Request(this.#url(path, { uploads: "" }), { method: "POST" }),
    );
    if (!created.ok) {
      await parts.close();
      throw await errorFromResponse(created);
    }
    const { uploadId } = (await created.json()) as { uploadId: string };
    try {
      let number = 1;
      for (;;) {
        await this.#retry(async () =>
          this.#expectOk(
            await this.#send(
              new Request(this.#url(path, { upload: uploadId, part: String(number) }), {
                method: "PUT",
                body: part as BodyInit,
              }),
            ),
          ),
        );
        if (!(await parts.hasMore())) break;
        if (number === this.#maxParts) {
          throw new Error(
            `webrun-files-http: ${path} needs more than ${this.#maxParts} parts of ${this.#partSize} bytes; raise partSize`,
          );
        }
        part = await parts.next();
        number++;
      }
      await this.#expectOk(
        await this.#send(
          new Request(this.#url(path, { upload: uploadId, complete: String(number) }), {
            method: "POST",
          }),
        ),
      );
    } catch (error) {
      await parts.close();
      await this.#send(
        new Request(this.#url(path, { upload: uploadId }), { method: "DELETE" }),
      ).catch(() => undefined);
      throw error;
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.#expectOk(await this.#operation(path, "MKCOL", "mkdir"));
  }

  async remove(path: string): Promise<boolean> {
    return this.#found(await this.#operation(path, "DELETE", "remove"));
  }

  async copy(source: string, target: string): Promise<boolean> {
    return this.#found(await this.#operation(source, "COPY", "copy", target));
  }

  async move(source: string, target: string): Promise<boolean> {
    return this.#found(await this.#operation(source, "MOVE", "move", target));
  }

  // -------------------------------------------------------------- private

  async #operation(path: string, verb: string, op: string, target?: string): Promise<Response> {
    if (this.#methods === "post") {
      const query: Record<string, string> = { op };
      if (target !== undefined) query.to = target;
      return this.#send(new Request(this.#url(path, query), { method: "POST" }));
    }
    const headers = new Headers();
    if (target !== undefined) headers.set("Destination", this.#url(target));
    return this.#send(new Request(this.#url(path), { method: verb, headers }));
  }

  #url(path: string, query?: Record<string, string>): string {
    return urlFor(this.#base, path, query);
  }

  async #expectOk(res: Response): Promise<void> {
    if (!res.ok) throw await errorFromResponse(res);
    await res.body?.cancel();
  }

  async #found(res: Response): Promise<boolean> {
    if (res.status === 404) {
      await res.body?.cancel();
      return false;
    }
    await this.#expectOk(res);
    return true;
  }

  async #retry(attempt: () => Promise<void>): Promise<void> {
    for (let failures = 0; ; failures++) {
      try {
        return await attempt();
      } catch (error) {
        if (failures >= this.#retries) throw error;
      }
    }
  }
}

function urlFor(base: URL, path: string, query?: Record<string, string>): string {
  const url = new URL(base);
  url.pathname = `${base.pathname}${encodeFilesPath(path)}`;
  if (query) {
    // `?list` rather than `?list=`: flags are presence-only.
    url.search = Object.entries(query)
      .map(([k, v]) =>
        v === "" ? encodeURIComponent(k) : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
      )
      .join("&");
  }
  return url.toString();
}

/**
 * Streamed request bodies work regardless of transport in Node, Deno and Bun.
 * Browsers either cannot send them (Firefox, Safari) or refuse them over
 * HTTP/1.1 (Chromium), so they get chunked uploads.
 */
function detectUploadMode(): "stream" | "chunked" {
  const g = globalThis as {
    process?: { versions?: { node?: string } };
    Deno?: unknown;
    Bun?: unknown;
  };
  const serverRuntime = Boolean(g.process?.versions?.node || g.Deno || g.Bun);
  return serverRuntime && supportsRequestStreams() ? "stream" : "chunked";
}

/**
 * The request-stream feature test: a runtime that supports stream bodies reads
 * the `duplex` option and does not treat the stream as text (which would set a
 * `Content-Type`).
 */
function supportsRequestStreams(): boolean {
  try {
    let duplexRead = false;
    const hasContentType = new Request("http://feature.test/", {
      method: "POST",
      body: new ReadableStream(),
      get duplex() {
        duplexRead = true;
        return "half";
      },
    } as RequestInit).headers.has("Content-Type");
    return duplexRead && !hasContentType;
  } catch {
    return false;
  }
}

/** Reads a source into parts of exactly `size` bytes (the last may be shorter), one part at a time. */
class PartReader {
  readonly #iterator: AsyncIterator<Uint8Array> | Iterator<Uint8Array>;
  readonly #size: number;
  #pending: Uint8Array | undefined;
  #done = false;

  constructor(source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, size: number) {
    this.#iterator =
      Symbol.asyncIterator in source
        ? source[Symbol.asyncIterator]()
        : (source as Iterable<Uint8Array>)[Symbol.iterator]();
    this.#size = size;
  }

  /** Whether another non-empty chunk remains; pulls at most one chunk ahead. */
  async hasMore(): Promise<boolean> {
    while (!this.#pending || this.#pending.length === 0) {
      if (this.#done) return false;
      const next = await this.#iterator.next();
      if (next.done) {
        this.#done = true;
        return false;
      }
      this.#pending = next.value;
    }
    return true;
  }

  async next(): Promise<Uint8Array> {
    const part = new Uint8Array(this.#size);
    let filled = 0;
    while (filled < this.#size && (await this.hasMore())) {
      const chunk = this.#pending as Uint8Array;
      const take = Math.min(chunk.length, this.#size - filled);
      part.set(chunk.subarray(0, take), filled);
      this.#pending = chunk.subarray(take);
      filled += take;
    }
    return filled === this.#size ? part : part.slice(0, filled);
  }

  async close(): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    await this.#iterator.return?.();
  }
}
