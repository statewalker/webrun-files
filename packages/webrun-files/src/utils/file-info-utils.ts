import type { FileInfo } from "../types.js";

/**
 * Check if FileInfo represents a directory
 */
export function isDirectory(info: FileInfo | undefined): boolean {
  return info?.kind === "directory";
}

/**
 * Check if FileInfo represents a file
 */
export function isFile(info: FileInfo | undefined): boolean {
  return info?.kind === "file";
}
