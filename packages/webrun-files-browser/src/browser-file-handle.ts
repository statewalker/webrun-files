/**
 * Browser FileHandle implementation using File System Access API.
 *
 * Provides random access read/write operations for browser files.
 * Uses File.slice() for efficient partial reads and FileSystemWritableFileStream
 * for writes.
 */

import type {
  AppendOptions,
  BinaryStream,
  FileHandle,
  ReadStreamOptions,
  WriteStreamOptions,
} from "@statewalker/webrun-files";

export interface BrowserFileHandleOptions {
  fileHandle: FileSystemFileHandle;
  initialFile: File;
}

export class BrowserFileHandle implements FileHandle {
  private fileHandle: FileSystemFileHandle;
  private file: File | null;
  private _size: number;
  private closed = false;

  constructor(options: BrowserFileHandleOptions) {
    this.fileHandle = options.fileHandle;
    this.file = options.initialFile;
    this._size = options.initialFile.size;
  }

  get size(): number {
    return this._size;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.file = null;
  }

  /**
   * Appends data to the end of the file.
   */
  async appendFile(data: BinaryStream, options: AppendOptions = {}): Promise<number> {
    if (this.closed) {
      throw new Error("FileHandle is closed");
    }

    const { signal } = options;
    const writable = await this.fileHandle.createWritable({ keepExistingData: true });
    let bytesWritten = 0;

    try {
      // Seek to end of file
      await writable.seek(this._size);

      for await (const chunk of data) {
        if (signal?.aborted) {
          throw new Error("Operation aborted");
        }
        // Cast to Uint8Array<ArrayBuffer> to satisfy FileSystemWritableFileStream.write()
        await writable.write(chunk as Uint8Array<ArrayBuffer>);
        bytesWritten += chunk.length;
      }
    } finally {
      await writable.close();
    }

    // Refresh file reference and size
    this.file = await this.fileHandle.getFile();
    this._size = this.file.size;

    return bytesWritten;
  }

  /**
   * Creates a read stream for the file.
   * Uses File.slice() for efficient partial reads.
   */
  async *createReadStream(options: ReadStreamOptions = {}): AsyncGenerator<Uint8Array> {
    if (this.closed) {
      throw new Error("FileHandle is closed");
    }

    // Ensure we have a fresh file reference
    if (!this.file) {
      this.file = await this.fileHandle.getFile();
      this._size = this.file.size;
    }

    const { start = 0, end = Infinity, signal } = options;
    const bufferSize = 8192;
    const actualEnd = Math.min(end, this._size);

    if (start >= actualEnd || this._size === 0) return;

    let position = start;

    while (position < actualEnd) {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const remaining = actualEnd - position;
      const toRead = Math.min(bufferSize, remaining);

      const slice = this.file.slice(position, position + toRead);
      const buffer = await slice.arrayBuffer();

      yield new Uint8Array(buffer);
      position += buffer.byteLength;
    }
  }

  /**
   * Writes data to the file starting at the specified position.
   * If start > 0, preserves content before start position.
   * Truncates file at start position before writing.
   */
  async createWriteStream(data: BinaryStream, options: WriteStreamOptions = {}): Promise<number> {
    if (this.closed) {
      throw new Error("FileHandle is closed");
    }

    const { start = 0, signal } = options;

    // Create writable stream, keeping existing data if we need to preserve content before start
    const writable = await this.fileHandle.createWritable({
      keepExistingData: start > 0,
    });

    let bytesWritten = 0;

    try {
      if (start > 0) {
        // Seek to start position
        await writable.seek(start);
        // Truncate at start position (removes content after start)
        await writable.truncate(start);
      }

      for await (const chunk of data) {
        if (signal?.aborted) {
          throw new Error("Operation aborted");
        }
        // Cast to Uint8Array<ArrayBuffer> to satisfy FileSystemWritableFileStream.write()
        await writable.write(chunk as Uint8Array<ArrayBuffer>);
        bytesWritten += chunk.length;
      }
    } finally {
      await writable.close();
    }

    // Refresh file reference and size
    this.file = await this.fileHandle.getFile();
    this._size = this.file.size;

    return bytesWritten;
  }

  /**
   * Random access read from file at a specific position.
   * Uses File.slice() for efficient partial reads.
   */
  async read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<number> {
    if (this.closed) {
      throw new Error("FileHandle is closed");
    }

    // Ensure we have a fresh file reference
    if (!this.file) {
      this.file = await this.fileHandle.getFile();
      this._size = this.file.size;
    }

    // Calculate actual bytes to read
    let len = Math.min(length, buffer.length - offset);
    len = Math.min(len, this._size - position);
    len = Math.max(0, len);

    if (len === 0) {
      return 0;
    }

    const slice = this.file.slice(position, position + len);
    const arrayBuffer = await slice.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    buffer.set(data, offset);
    return len;
  }
}
