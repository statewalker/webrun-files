/**
 * webrun-files - Cross-platform filesystem API
 */

// Wrapper class
export { FilesApi } from "./files-api.js";
// Implementations
export { MemFilesApi } from "./impl/mem-files-api.js";
export { NodeFilesApi } from "./impl/node-files-api.js";
// Types
export type {
  AppendOptions,
  BinaryStream,
  CopyOptions,
  FileHandle,
  FileInfo,
  FileKind,
  FileRef,
  IFilesApi,
  ListOptions,
  ReadStreamOptions,
  WriteStreamOptions,
} from "./types.js";
export {
  collectGenerator,
  toAsyncIterable,
  toBinaryAsyncIterable,
} from "./utils/collect-stream.js";
// Utilities
export {
  normalizePath,
  resolveFileRef,
  toPath,
} from "./utils/normalize-path.js";
export { basename, dirname, extname, joinPath } from "./utils/path-utils.js";
