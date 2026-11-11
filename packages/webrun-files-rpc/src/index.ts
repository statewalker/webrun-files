/**
 * webrun-files-rpc: a FilesApi over any RPC. The server serves a FilesApi as plain calls; the
 * client is a FilesApi over them. Content is streamed as chunks keyed by (streamId, chunkId):
 * both sides keep chunks by their key and wait for those still on their way, so calls may arrive
 * out of order, concurrently, or twice.
 */
export { FilesRpcClient, type FilesRpcClientOptions, newFilesRpcClient } from "./client.js";
export { errorCode, FilesRpcError } from "./errors.js";
export { type FilesRpcServer, type FilesRpcServerOptions, newFilesRpcServer } from "./server.js";
export type {
  AppendableFilesApi,
  FilesRpc,
  FilesRpcErrorCode,
  ListPage,
  ListPageOptions,
  OpenOptions,
  OpenReadOptions,
  OpenWriteOptions,
  ReadResult,
} from "./types.js";
