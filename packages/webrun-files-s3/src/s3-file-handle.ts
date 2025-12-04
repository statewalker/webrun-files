/**
 * S3 FileHandle implementation
 *
 * Provides random access read/write operations for S3 objects.
 * Uses HTTP Range headers for efficient partial reads.
 * Since S3 objects are immutable, writes require re-uploading the entire object.
 */

import type { S3Client } from "@aws-sdk/client-s3";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import type {
  AppendOptions,
  BinaryStream,
  FileHandle,
  ReadStreamOptions,
  WriteStreamOptions,
} from "@statewalker/webrun-files";
import { toBinaryAsyncIterable } from "@statewalker/webrun-files";

export interface S3FileHandleOptions {
  client: S3Client;
  bucket: string;
  key: string;
  size: number;
  bufferSize: number;
  multipartPartSize: number;
}

/**
 * Helper to consume S3 response body as Uint8Array.
 * Handles both Node.js Readable streams and browser ReadableStreams.
 */
async function consumeBody(body: unknown): Promise<Uint8Array> {
  // AWS SDK v3 provides transformToByteArray on the body
  if (body && typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    return (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
  }

  // Fallback: try to consume as async iterable
  if (body && (Symbol.asyncIterator in (body as object))) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBufferLike));
    }
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0];

    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  // If it's already a Uint8Array or ArrayBuffer
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }

  throw new Error("Unsupported body type");
}

export class S3FileHandle implements FileHandle {
  private client: S3Client;
  private bucket: string;
  private key: string;
  private _size: number;
  private bufferSize: number;
  private multipartPartSize: number;
  private closed = false;

  constructor(options: S3FileHandleOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
    this.key = options.key;
    this._size = options.size;
    this.bufferSize = options.bufferSize;
    this.multipartPartSize = options.multipartPartSize;
  }

  get size(): number {
    return this._size;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /**
   * Reads a range of bytes from the S3 object.
   * Uses HTTP Range header for efficient partial reads.
   */
  async *createReadStream(
    options: ReadStreamOptions = {},
  ): AsyncGenerator<Uint8Array> {
    if (this.closed) {
      throw new Error("FileHandle is closed");
    }

    const { start = 0, end = Infinity, signal } = options;
    const actualEnd = Math.min(end, this._size);

    if (start >= actualEnd || this._size === 0) return;

    // Read the range and yield in chunks
    const content = await this.readRange(start, actualEnd, signal);

    // Yield content in buffer-sized chunks
    let position = 0;
    while (position < content.length) {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      const chunkEnd = Math.min(position + this.bufferSize, content.length);
      yield content.subarray(position, chunkEnd);
      position = chunkEnd;
    }
  }

  /**
   * Writes content to the S3 object.
   *
   * S3 objects are immutable, so this operation replaces the entire object.
   * For small files, uses PutObject. For large files, uses multipart upload.
   *
   * Note: start position > 0 requires downloading existing content first.
   */
  async createWriteStream(
    data: BinaryStream,
    options: WriteStreamOptions = {},
  ): Promise<number> {
    if (this.closed) {
      throw new Error("FileHandle is closed");
    }

    const { start = 0, signal } = options;

    // Collect all data first (S3 needs content-length or multipart)
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    // If start > 0, we need to preserve existing content
    if (start > 0 && this._size > 0) {
      const preserved = await this.readRange(
        0,
        Math.min(start, this._size),
        signal,
      );
      chunks.push(preserved);
      totalLength = preserved.length;

      // Pad with zeros if start is beyond current content
      if (start > this._size) {
        const padding = new Uint8Array(start - this._size);
        chunks.push(padding);
        totalLength += padding.length;
      }
    } else if (start > 0) {
      // File is empty but start > 0, need to pad
      const padding = new Uint8Array(start);
      chunks.push(padding);
      totalLength += padding.length;
    }

    // Collect new data
    let bytesWritten = 0;
    for await (const chunk of toBinaryAsyncIterable(data)) {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      chunks.push(chunk);
      totalLength += chunk.length;
      bytesWritten += chunk.length;
    }

    // Merge chunks
    const content = this.mergeChunks(chunks, totalLength);

    // Choose upload method based on size
    if (content.length < this.multipartPartSize) {
      await this.putObject(content, signal);
    } else {
      await this.multipartUpload(content, signal);
    }

    this._size = content.length;
    return bytesWritten;
  }

  /**
   * Appends content to the end of the S3 object.
   *
   * Since S3 objects are immutable, this downloads existing content,
   * appends new data, and uploads the combined result.
   */
  async appendFile(data: BinaryStream, options: AppendOptions = {}): Promise<number> {
    if (this.closed) {
      throw new Error("FileHandle is closed");
    }

    const { signal } = options;

    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    // Download existing content
    if (this._size > 0) {
      const existing = await this.readRange(0, this._size, signal);
      chunks.push(existing);
      totalLength = existing.length;
    }

    // Append new data
    let bytesWritten = 0;
    for await (const chunk of toBinaryAsyncIterable(data)) {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      chunks.push(chunk);
      totalLength += chunk.length;
      bytesWritten += chunk.length;
    }

    // Merge and upload
    const content = this.mergeChunks(chunks, totalLength);

    if (content.length < this.multipartPartSize) {
      await this.putObject(content, signal);
    } else {
      await this.multipartUpload(content, signal);
    }

    this._size = content.length;
    return bytesWritten;
  }

  // ========================================
  // Private helpers
  // ========================================

  private async readRange(
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (end <= start || this._size === 0) {
      return new Uint8Array(0);
    }

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.key,
      Range: `bytes=${start}-${end - 1}`,
    });

    const response = await this.client.send(command, { abortSignal: signal });

    if (!response.Body) {
      return new Uint8Array(0);
    }

    return consumeBody(response.Body);
  }

  private mergeChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0];

    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  private async putObject(
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.key,
      Body: content,
      ContentLength: content.length,
    });

    await this.client.send(command, { abortSignal: signal });
  }

  private async multipartUpload(
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    // Initiate multipart upload
    const createCommand = new CreateMultipartUploadCommand({
      Bucket: this.bucket,
      Key: this.key,
    });

    const { UploadId } = await this.client.send(createCommand, {
      abortSignal: signal,
    });

    if (!UploadId) {
      throw new Error("Failed to initiate multipart upload");
    }

    const parts: { ETag: string; PartNumber: number }[] = [];

    try {
      let offset = 0;
      let partNumber = 1;

      while (offset < content.length) {
        if (signal?.aborted) {
          throw new Error("Operation aborted");
        }

        const end = Math.min(offset + this.multipartPartSize, content.length);
        const partData = content.subarray(offset, end);

        const uploadCommand = new UploadPartCommand({
          Bucket: this.bucket,
          Key: this.key,
          UploadId,
          PartNumber: partNumber,
          Body: partData,
          ContentLength: partData.length,
        });

        const { ETag } = await this.client.send(uploadCommand, {
          abortSignal: signal,
        });

        parts.push({ ETag: ETag!, PartNumber: partNumber });

        offset = end;
        partNumber++;
      }

      // Complete multipart upload
      const completeCommand = new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.key,
        UploadId,
        MultipartUpload: { Parts: parts },
      });

      await this.client.send(completeCommand, { abortSignal: signal });
    } catch (error) {
      // Abort on failure to clean up
      const abortCommand = new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.key,
        UploadId,
      });

      await this.client.send(abortCommand).catch(() => {
        // Ignore abort errors
      });

      throw error;
    }
  }
}
