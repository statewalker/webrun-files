/**
 * webrun-files - Cross-platform filesystem API
 *
 * This package provides:
 * - FilesApi interface for filesystem abstraction
 * - Utility functions for common file operations
 * - Path manipulation utilities
 *
 * For implementations, use:
 * - @statewalker/webrun-files-mem (in-memory)
 * - @statewalker/webrun-files-node (Node.js)
 * - @statewalker/webrun-files-browser (browser)
 * - @statewalker/webrun-files-s3 (S3)
 * - @statewalker/webrun-files-sqlite (SQLite: node:sqlite, Durable Objects, D1)
 * - @statewalker/webrun-files-composite (mount several backends as one tree)
 */

// File utilities
export {
  readAt,
  readFile,
  readRange,
  readText,
  tryReadFile,
  tryReadText,
  writeText,
} from "./file-utils.js";
// Path utilities
export {
  basename,
  dirname,
  extname,
  joinPath,
  normalizePath,
} from "./path-utils.js";
// Core types
export type {
  DirectoryEntryInfo,
  DirectoryEntryStats,
  FileEntryInfo,
  FileEntryLocation,
  FileEntryStats,
  FileInfo,
  FileKind,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "./types.js";
