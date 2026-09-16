import type { FilesApi } from "@statewalker/webrun-files";

/** A `fetch`-shaped request handler: what the server stub is, and what the client stub calls. */
export type FetchHandler = (req: Request) => Promise<Response>;

export interface ServerStubOptions {
  /** The file system served, or one chosen per request (per user, per tenant, wrapped in guards). */
  fs: FilesApi | ((req: Request) => FilesApi | Promise<FilesApi>);
  /** URL path prefix the handler is mounted at. Default `"/"`. */
  basePath?: string;
  /** Runs first. Returning a `Response` ends the request there (authentication, CORS preflight). */
  onRequest?: (req: Request) => Response | undefined | Promise<Response | undefined>;
  /** Runs last, on every response the stub produces, errors included (headers, CORS). */
  onResponse?: (req: Request, res: Response) => Response | Promise<Response>;
  /** Where chunked-upload parts wait until the upload completes. Default: an in-memory `MemFilesApi`. */
  staging?: FilesApi;
  /** Smallest part accepted, except the last. Default 5 MiB. */
  minPartSize?: number;
  /** Largest part accepted. Default 64 MiB. */
  maxPartSize?: number;
  /** Most parts per upload. Default 10 000. */
  maxParts?: number;
  /** Largest listing page. Default 256. */
  maxPageSize?: number;
  /** Which verb forms are served: MKCOL/COPY/MOVE/DELETE (`http`) and `POST ?op=` (`post`). Default: both. */
  methods?: { http?: boolean; post?: boolean };
}

/** The server stub: a `FetchHandler`, plus maintenance of abandoned uploads. */
export interface FilesServerHandler extends FetchHandler {
  /** Delete uploads created more than `olderThan` ms ago, and orphan parts older than that. Returns how many uploads. */
  sweepUploads(options: { olderThan: number }): Promise<number>;
}

export interface ClientStubOptions {
  /** Where the server stub is mounted, e.g. `https://example.com/api/files`. */
  baseUrl: string | URL;
  /** Adjust every outgoing request: headers, signing. */
  setHeaders?: (req: Request) => Request | Promise<Request>;
  /** Default: `globalThis.fetch`. */
  fetch?: FetchHandler;
  /** `"http"` sends MKCOL / COPY / MOVE / DELETE; `"post"` sends `POST ?op=…`. Default `"http"`. */
  methods?: "http" | "post";
  /** `"stream"` sends one streamed PUT, `"chunked"` sends parts. Default `"auto"`. */
  upload?: "auto" | "stream" | "chunked";
  /** Part size for chunked uploads. Default: the server's `minPartSize`. */
  partSize?: number;
  /** Listing page size. Default: the server's `maxPageSize`. */
  pageSize?: number;
  /** Retries of a failed listing page or upload part. Default 2. */
  retries?: number;
}

/** What `GET {base}/?capabilities` answers. */
export interface ServerCapabilities {
  version: 1;
  minPartSize: number;
  maxPartSize: number;
  maxParts: number;
  maxPageSize: number;
  methods: { http: boolean; post: boolean };
}
