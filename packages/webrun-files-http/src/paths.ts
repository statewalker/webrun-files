import { normalizePath } from "@statewalker/webrun-files";
import { HttpError } from "./errors.js";

/**
 * A FilesApi path as a URL path under `basePath`: every segment
 * `encodeURIComponent`-ed, so `%`, `#`, `?`, `+`, spaces and non-ASCII
 * survive. A `..` segment is refused: URL parsing would silently resolve it
 * into a different path.
 */
export function encodeFilesPath(path: string): string {
  const normalized = normalizePath(path);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((s) => s === "..")) {
    throw new Error(`webrun-files-http: path must not contain "..": ${path}`);
  }
  return `/${segments.map(encodeURIComponent).join("/")}`;
}

/** `basePath` as a prefix without a trailing slash; the root is `""`. */
export function normalizeBasePath(basePath: string): string {
  const normalized = normalizePath(basePath);
  return normalized === "/" ? "" : normalized;
}

/**
 * The FilesApi path a URL path addresses under `base`. `404` outside `base`;
 * `400` for a `.` or `..` segment or an encoded `/`, which no FilesApi path
 * can hold.
 */
export function decodeFilesPath(pathname: string, base: string): string {
  let rest: string;
  if (pathname === base || pathname === `${base}/`) rest = "";
  else if (pathname.startsWith(`${base}/`)) rest = pathname.slice(base.length + 1);
  else throw new HttpError(404, `Not under the files endpoint: ${pathname}`, "NotFound");

  const segments: string[] = [];
  for (const raw of rest.split("/")) {
    if (raw === "") continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      throw new HttpError(400, `Malformed path segment: ${raw}`, "BadRequest");
    }
    if (segment === "." || segment === ".." || segment.includes("/")) {
      throw new HttpError(400, `Invalid path segment: ${raw}`, "BadRequest");
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}
