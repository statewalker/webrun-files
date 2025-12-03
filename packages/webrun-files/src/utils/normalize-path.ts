/**
 * Path normalization utilities
 */

import type { FileRef } from "../types.js";

/**
 * Normalizes a file path to a consistent format.
 * - Adds leading slash if missing
 * - Removes trailing slash
 * - Removes `.` segments
 * - Collapses multiple slashes
 */
export function normalizePath(filePath: string): string {
  const segments = filePath.split("/").filter((s) => !!s && s !== ".");
  if (segments.length === 0) {
    return "/";
  }
  return `/${segments.join("/")}`;
}

/**
 * Extracts path string from FileRef.
 */
export function toPath(file: FileRef): string {
  return typeof file === "object" ? file.path : String(file);
}

/**
 * Normalizes FileRef to a path string.
 */
export function resolveFileRef(file: FileRef): string {
  return normalizePath(toPath(file));
}
