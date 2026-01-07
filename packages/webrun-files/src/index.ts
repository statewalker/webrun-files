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
 */

// Core types
export type {
  FileInfo,
  FileKind,
  FilesApi,
  FileStats,
  ListOptions,
  ReadOptions,
} from "./types.js";

// File utilities
export {
  readFile,
  readText,
  tryReadFile,
  tryReadText,
  readRange,
  readAt,
  writeText,
} from "./file-utils.js";

// Path utilities
export {
  normalizePath,
  joinPath,
  dirname,
  basename,
  extname,
} from "./path-utils.js";
