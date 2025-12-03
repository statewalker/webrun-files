/**
 * Path manipulation utilities
 */

import { normalizePath } from "./normalize-path.js";

/**
 * Joins path segments with proper normalization.
 */
export function joinPath(...segments: string[]): string {
  const combined = segments.join("/");
  return normalizePath(combined);
}

/**
 * Returns the directory portion of a path.
 */
export function dirname(path: string): string {
  const normalized = normalizePath(path);
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return normalized.substring(0, lastSlash);
}

/**
 * Returns the filename portion of a path.
 */
export function basename(path: string, ext?: string): string {
  const normalized = normalizePath(path);
  const lastSlash = normalized.lastIndexOf("/");
  const name = lastSlash === -1 ? normalized : normalized.substring(lastSlash + 1);
  if (ext && name.endsWith(ext)) {
    return name.substring(0, name.length - ext.length);
  }
  return name;
}

/**
 * Returns the file extension including the dot.
 */
export function extname(path: string): string {
  const name = basename(path);
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) return "";
  return name.substring(dotIndex);
}
