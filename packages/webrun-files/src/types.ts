/**
 * Type definitions for IFilesApi
 */

export type FileKind = "file" | "directory";

export interface FileInfo {
  kind: FileKind;
  name: string;
  path: string;
  type?: string;
  size?: number;
  lastModified: number;
}

export type FileRef = string | { path: string };

export interface ListOptions {
  recursive?: boolean;
}

export interface CopyOptions {
  recursive?: boolean;
}

export interface AppendOptions {
  signal?: AbortSignal;
}

export interface ReadStreamOptions {
  start?: number;
  end?: number;
  signal?: AbortSignal;
}

export interface WriteStreamOptions {
  start?: number;
  signal?: AbortSignal;
}

export type BinaryStream = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

export interface FileHandle {
  readonly size: number;
  close(): Promise<void>;

  appendFile(data: BinaryStream, options?: AppendOptions): Promise<number>;
  createReadStream(options?: ReadStreamOptions): AsyncGenerator<Uint8Array>;
  createWriteStream(data: BinaryStream, options?: WriteStreamOptions): Promise<number>;

  /**
   * Read bytes from the file at a specific position.
   *
   * @param buffer - The buffer to read bytes into
   * @param offset - The offset in the buffer to start writing at
   * @param length - The number of bytes to read
   * @param position - The position in the file to start reading from
   * @returns The number of bytes actually read (may be less than length at EOF)
   */
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<number>;

  chmod?(mode: number): Promise<void>;
  chown?(uid: number, gid: number): Promise<void>;
}

/**
 * Core filesystem interface - minimal contract for implementations.
 * Platform-specific implementations should implement this interface.
 */
export interface IFilesApi {
  list(file: FileRef, options?: ListOptions): AsyncGenerator<FileInfo>;
  stats(file: FileRef): Promise<FileInfo | undefined>;
  remove(file: FileRef): Promise<boolean>;
  open(file: FileRef): Promise<FileHandle>;

  move?(source: FileRef, target: FileRef): Promise<boolean>;
  copy?(source: FileRef, target: FileRef, options?: CopyOptions): Promise<boolean>;
  mkdir?(file: FileRef): Promise<void>;
}
