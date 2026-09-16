import type { FilesApi } from "@statewalker/webrun-files";
import { readText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { errorResponse, HttpError } from "./errors.js";
import { decodeFilesPath, normalizeBasePath } from "./paths.js";
import { fromStream, toStream } from "./streams.js";
import type { FilesServerHandler, ServerCapabilities, ServerStubOptions } from "./types.js";

const MiB = 1024 * 1024;
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface UploadMeta {
  path: string;
  created: number;
}

/**
 * Serve a `FilesApi` over HTTP as a `(Request) => Response` handler.
 *
 * Every request runs `onRequest` first (a returned response ends it there),
 * then the operation its method and query name, then `onResponse` on the
 * result — errors included. Chunked-upload parts wait in `staging`, never in
 * the served file system, until the upload completes.
 */
export function newServerStub(options: ServerStubOptions): FilesServerHandler {
  const base = normalizeBasePath(options.basePath ?? "/");
  const staging = options.staging ?? new MemFilesApi();
  const capabilities: ServerCapabilities = {
    version: 1,
    minPartSize: options.minPartSize ?? 5 * MiB,
    maxPartSize: options.maxPartSize ?? 64 * MiB,
    maxParts: options.maxParts ?? 10_000,
    maxPageSize: options.maxPageSize ?? 256,
    methods: { http: options.methods?.http ?? true, post: options.methods?.post ?? true },
  };
  const resolveFs = async (req: Request): Promise<FilesApi> =>
    typeof options.fs === "function" ? options.fs(req) : options.fs;

  const uploads = new Uploads(staging, capabilities);

  async function route(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    const url = new URL(req.url);
    const path = decodeFilesPath(url.pathname, base);
    const query = url.searchParams;

    if (req.method === "GET" && query.has("capabilities")) return Response.json(capabilities);
    const fs = await resolveFs(req);

    switch (req.method) {
      case "GET":
        return query.has("list") ? list(fs, path, query) : read(fs, path, req);
      case "HEAD":
        return stats(fs, path);
      case "PUT":
        if (query.has("upload")) return uploads.putPart(path, query, req);
        await fs.write(path, fromStream(req.body));
        return noContent();
      case "POST":
        if (query.has("uploads")) return uploads.create(path);
        if (query.has("upload") && query.has("complete")) return uploads.complete(fs, path, query);
        if (query.has("op")) {
          requireForm("post");
          return operation(fs, req, path, query.get("op") ?? "", query.get("to"));
        }
        throw new HttpError(400, "POST needs ?uploads, ?upload&complete or ?op", "BadRequest");
      case "DELETE":
        if (query.has("upload")) return uploads.abort(query);
        requireForm("http");
        return operation(fs, req, path, "remove", null);
      case "MKCOL":
        requireForm("http");
        return operation(fs, req, path, "mkdir", null);
      case "COPY":
      case "MOVE":
        requireForm("http");
        return operation(fs, req, path, req.method.toLowerCase(), null);
      default:
        throw new HttpError(405, `Method not allowed: ${req.method}`, "MethodNotAllowed");
    }
  }

  function requireForm(form: "http" | "post") {
    if (!capabilities.methods[form]) {
      throw new HttpError(405, `The ${form} verb form is disabled`, "MethodNotAllowed");
    }
  }

  async function operation(
    fs: FilesApi,
    req: Request,
    path: string,
    op: string,
    to: string | null,
  ): Promise<Response> {
    switch (op) {
      case "mkdir":
        await fs.mkdir(path);
        return noContent();
      case "remove":
        return (await fs.remove(path)) ? noContent() : notFound(path);
      case "copy":
      case "move": {
        const target = to ?? destinationOf(req);
        const done = op === "copy" ? await fs.copy(path, target) : await fs.move(path, target);
        return done ? noContent() : notFound(path);
      }
      default:
        throw new HttpError(400, `Unknown operation: ${op}`, "BadRequest");
    }
  }

  function destinationOf(req: Request): string {
    const destination = req.headers.get("Destination");
    if (!destination) throw new HttpError(400, "Missing Destination header", "BadRequest");
    return decodeFilesPath(new URL(destination, req.url).pathname, base);
  }

  async function list(fs: FilesApi, path: string, query: URLSearchParams): Promise<Response> {
    const requested = Number.parseInt(query.get("limit") ?? "", 10);
    const limit = Math.min(
      Number.isFinite(requested) && requested > 0 ? requested : capabilities.maxPageSize,
      capabilities.maxPageSize,
    );
    const recursive = query.get("recursive") === "1";
    const after = query.get("after") ?? undefined;
    const items = [];
    // Stops the iterator at a full page: nothing stays open between requests.
    for await (const entry of fs.list(path, { recursive, after })) {
      items.push(entry);
      if (items.length === limit) break;
    }
    const next = items.length === limit ? items[items.length - 1].path : undefined;
    return Response.json(next === undefined ? { items } : { items, next });
  }

  const handler = async (req: Request): Promise<Response> => {
    let res: Response;
    try {
      res = (await options.onRequest?.(req)) ?? (await route(req));
    } catch (error) {
      res = errorResponse(error);
    }
    return options.onResponse ? options.onResponse(req, res) : res;
  };
  return Object.assign(handler, {
    sweepUploads: (sweep: { olderThan: number }) => uploads.sweep(sweep.olderThan),
  });
}

async function read(fs: FilesApi, path: string, req: Request): Promise<Response> {
  const stats = await fs.stats(path);
  if (stats?.kind !== "file") return notFound(path);
  const size = stats.size;
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Accept-Ranges": "bytes",
    "X-Last-Modified-Ms": String(stats.lastModified),
  });

  const range = parseRange(req.headers.get("Range"), size);
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const start = range?.start ?? 0;
  const length = range ? range.end - range.start + 1 : size;
  headers.set("Content-Length", String(length));
  if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  const body = length === 0 ? null : toStream(fs.read(path, { start, length }));
  return new Response(body, { status: range ? 206 : 200, headers });
}

/** `bytes=s-e`, `bytes=s-` and `bytes=-n`; anything else is ignored, as HTTP allows. */
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === "" && match[2] === "")) return undefined;
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

async function stats(fs: FilesApi, path: string): Promise<Response> {
  const stats = await fs.stats(path);
  if (!stats) return new Response(null, { status: 404 });
  const headers = new Headers({ "X-File-Kind": stats.kind });
  if (stats.kind === "file") {
    // X-File-Size, not only Content-Length: intermediaries rewrite the latter on HEAD.
    headers.set("X-File-Size", String(stats.size));
    headers.set("X-Last-Modified-Ms", String(stats.lastModified));
  }
  return new Response(null, { status: 200, headers });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function notFound(path: string): Response {
  return errorResponse(new HttpError(404, `Not found: ${path}`, "NotFound"));
}

/** Chunked uploads: parts in `staging` under `{dd}/{uuid}-{nnnnnn}.bin`, metadata in `{dd}/{uuid}.json`. */
class Uploads {
  readonly #staging: FilesApi;
  readonly #limits: ServerCapabilities;

  constructor(staging: FilesApi, limits: ServerCapabilities) {
    this.#staging = staging;
    this.#limits = limits;
  }

  async create(path: string): Promise<Response> {
    const id = crypto.randomUUID();
    const meta: UploadMeta = { path, created: Date.now() };
    await this.#staging.write(metaPath(id), [new TextEncoder().encode(JSON.stringify(meta))]);
    return Response.json({ uploadId: id }, { status: 201 });
  }

  async putPart(path: string, query: URLSearchParams, req: Request): Promise<Response> {
    const id = this.#id(query);
    await this.#meta(id, path);
    const part = Number(query.get("part"));
    if (!Number.isInteger(part) || part < 1 || part > this.#limits.maxParts) {
      throw new HttpError(400, `Part number must be 1..${this.#limits.maxParts}`, "BadRequest");
    }
    const target = partPath(id, part);
    try {
      await this.#staging.write(target, limitBytes(fromStream(req.body), this.#limits.maxPartSize));
    } catch (error) {
      await this.#staging.remove(target).catch(() => false);
      throw error;
    }
    return noContent();
  }

  async complete(fs: FilesApi, path: string, query: URLSearchParams): Promise<Response> {
    const id = this.#id(query);
    await this.#meta(id, path);
    const count = Number(query.get("complete"));
    if (!Number.isInteger(count) || count < 1 || count > this.#limits.maxParts) {
      throw new HttpError(400, `Part count must be 1..${this.#limits.maxParts}`, "BadRequest");
    }
    for (let part = 1; part <= count; part++) {
      const stats = await this.#staging.stats(partPath(id, part));
      if (stats?.kind !== "file") throw new HttpError(400, `Missing part ${part}`, "BadRequest");
      if (part < count && stats.size < this.#limits.minPartSize) {
        throw new HttpError(
          400,
          `Part ${part} holds ${stats.size} bytes; parts before the last need ${this.#limits.minPartSize}`,
          "BadRequest",
        );
      }
    }
    const staging = this.#staging;
    async function* parts() {
      for (let part = 1; part <= count; part++) yield* staging.read(partPath(id, part));
    }
    try {
      await fs.write(path, parts());
    } finally {
      await this.#discard(id);
    }
    return noContent();
  }

  async abort(query: URLSearchParams): Promise<Response> {
    await this.#discard(this.#id(query));
    return noContent();
  }

  async sweep(olderThan: number): Promise<number> {
    if (!(Number.isFinite(olderThan) && olderThan >= 0)) {
      throw new Error(`sweepUploads: olderThan must be a finite number >= 0, got ${olderThan}`);
    }
    const cutoff = Date.now() - olderThan;
    const stale = new Set<string>();
    const fresh = new Set<string>();
    const orphanParts: string[] = [];
    for await (const entry of this.#staging.list("/", { recursive: true })) {
      if (entry.kind !== "file") continue;
      const meta = entry.name.match(/^([0-9a-f-]{36})\.json$/);
      if (meta) {
        const created = await this.#created(entry.path);
        (created !== undefined && created >= cutoff ? fresh : stale).add(meta[1]);
        continue;
      }
      const part = entry.name.match(/^([0-9a-f-]{36})-\d{6}\.bin$/);
      if (part && entry.lastModified < cutoff) orphanParts.push(`${part[1]}|${entry.path}`);
    }
    for (const id of stale) await this.#discard(id);
    for (const orphan of orphanParts) {
      const [id, path] = orphan.split("|");
      if (!fresh.has(id) && !stale.has(id)) await this.#staging.remove(path);
    }
    return stale.size;
  }

  async #created(path: string): Promise<number | undefined> {
    try {
      return (JSON.parse(await readText(this.#staging, path)) as UploadMeta).created;
    } catch {
      return undefined;
    }
  }

  #id(query: URLSearchParams): string {
    const id = query.get("upload") ?? "";
    if (!UPLOAD_ID.test(id)) throw new HttpError(400, "Malformed upload id", "BadRequest");
    return id;
  }

  /** The upload's metadata; `404` if unknown, `409` if opened for another path. */
  async #meta(id: string, path: string): Promise<UploadMeta> {
    let meta: UploadMeta;
    try {
      meta = JSON.parse(await readText(this.#staging, metaPath(id))) as UploadMeta;
    } catch {
      throw new HttpError(404, `Unknown upload: ${id}`, "NotFound");
    }
    if (meta.path !== path) {
      throw new HttpError(409, `Upload ${id} was opened for another path`, "Conflict");
    }
    return meta;
  }

  async #discard(id: string): Promise<void> {
    const dir = `/${id.slice(0, 2)}`;
    const names: string[] = [];
    for await (const entry of this.#staging.list(dir, { after: `${dir}/${id}` })) {
      if (!entry.name.startsWith(id)) break;
      names.push(entry.path);
    }
    for (const path of names) await this.#staging.remove(path);
  }
}

function metaPath(id: string): string {
  return `/${id.slice(0, 2)}/${id}.json`;
}

function partPath(id: string, part: number): string {
  return `/${id.slice(0, 2)}/${id}-${String(part).padStart(6, "0")}.bin`;
}

async function* limitBytes(
  source: AsyncIterable<Uint8Array>,
  max: number,
): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of source) {
    total += chunk.length;
    if (total > max) throw new HttpError(413, `Part exceeds ${max} bytes`, "PayloadTooLarge");
    yield chunk;
  }
}
