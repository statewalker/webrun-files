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
  UploadPartCommand,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import type {
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
  multipartPartSize: number;
}

/**
 * Helper to stream S3 response body as async iterable of Uint8Array chunks.
 * Handles both Node.js Readable streams and browser ReadableStreams.
 * Yields chunks as they arrive without buffering the entire response.
 */
async function* streamBody(body: unknown): AsyncGenerator<Uint8Array> {
  if (!body) return;

  // AWS SDK v3 body supports async iteration
  if (Symbol.asyncIterator in (body as object)) {
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBufferLike);
    }
    return;
  }

  // If it's already a Uint8Array or ArrayBuffer
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  if (body instanceof ArrayBuffer) {
    yield new Uint8Array(body);
    return;
  }

  throw new Error("Unsupported body type");
}

export class S3FileHandle implements FileHandle {
  private client: S3Client;
  private bucket: string;
  private key: string;
  private _size: number;
  private multipartPartSize: number;
  private closed = false;

  constructor(options: S3FileHandleOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
    this.key = options.key;
    this._size = options.size;
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
   * Streams data directly from S3 without buffering the entire response.
   */
  async *createReadStream(options: ReadStreamOptions = {}): AsyncGenerator<Uint8Array> {
    if (this.closed) {
      throw new Error("FileHandle is closed");
    }

    const { start = 0, end = Infinity, signal } = options;
    const actualEnd = Math.min(end, this._size);

    if (start >= actualEnd || this._size === 0) return;

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.key,
      Range: `bytes=${start}-${actualEnd - 1}`,
    });

    const response = await this.client.send(command, { abortSignal: signal });

    if (!response.Body) return;

    // Stream directly from S3 response body
    for await (const chunk of streamBody(response.Body)) {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      yield chunk;
    }
  }

  /**
   * Writes content to the S3 object using streaming.
   *
   * S3 objects are immutable, so this operation replaces the entire object.
   * Uses streaming multipart upload to avoid buffering the entire file in memory.
   * Only buffers one part at a time (5MB by default).
   *
   * Note: start position > 0 uses UploadPartCopy to preserve existing content
   * without downloading it.
   * To append data, use `writeStream(data, { start: this.size })`.
   */
  async writeStream(data: BinaryStream, options: WriteStreamOptions = {}): Promise<number> {
    if (this.closed) {
      throw new Error("FileHandle is closed");
    }

    const { start = 0, signal } = options;

    // Use streaming multipart upload
    return this.streamingMultipartUpload(data, start, signal);
  }

  // ========================================
  // Private helpers
  // ========================================

  /**
   * Streaming multipart upload that buffers only one part at a time.
   * Uses UploadPartCopy to preserve existing content without downloading it
   * for large files. For small existing content (< part size), downloads and
   * combines with new data to meet S3's minimum part size requirement.
   */
  private async streamingMultipartUpload(
    data: BinaryStream,
    start: number,
    signal?: AbortSignal,
  ): Promise<number> {
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
    let partNumber = 1;
    let bytesWritten = 0;
    let totalSize = 0;

    // Buffer for accumulating data before uploading parts
    let buffer = new Uint8Array(this.multipartPartSize);
    let bufferOffset = 0;

    try {
      // Handle preserving existing content
      if (start > 0 && this._size > 0) {
        const preserveEnd = Math.min(start, this._size);

        // Use UploadPartCopy for full-sized parts (>= 5MB)
        // Download and buffer remaining bytes that don't fill a complete part
        const fullPartsEnd =
          Math.floor(preserveEnd / this.multipartPartSize) * this.multipartPartSize;

        // Copy full parts using UploadPartCopy (no download needed)
        let copyOffset = 0;
        while (copyOffset < fullPartsEnd) {
          if (signal?.aborted) {
            throw new Error("Operation aborted");
          }

          const copyEnd = copyOffset + this.multipartPartSize;

          const copyCommand = new UploadPartCopyCommand({
            Bucket: this.bucket,
            Key: this.key,
            UploadId,
            PartNumber: partNumber,
            CopySource: `${this.bucket}/${this.key}`,
            CopySourceRange: `bytes=${copyOffset}-${copyEnd - 1}`,
          });

          const { CopyPartResult } = await this.client.send(copyCommand, {
            abortSignal: signal,
          });

          if (CopyPartResult?.ETag) {
            parts.push({ ETag: CopyPartResult.ETag, PartNumber: partNumber });
            partNumber++;
            totalSize += this.multipartPartSize;
          }

          copyOffset = copyEnd;
        }

        // Download remaining bytes (less than part size) and add to buffer
        if (fullPartsEnd < preserveEnd) {
          const remainingBytes = await this.downloadRange(fullPartsEnd, preserveEnd, signal);
          buffer.set(remainingBytes, bufferOffset);
          bufferOffset += remainingBytes.length;
          totalSize += remainingBytes.length;
        }

        // Handle padding if start is beyond current size
        if (start > this._size) {
          const paddingSize = start - this._size;
          // Add padding to buffer, uploading full parts as needed
          let paddingOffset = 0;
          while (paddingOffset < paddingSize) {
            const spaceInBuffer = this.multipartPartSize - bufferOffset;
            const bytesToAdd = Math.min(spaceInBuffer, paddingSize - paddingOffset);

            // Zero-fill the buffer (it's already zeros from allocation)
            bufferOffset += bytesToAdd;
            paddingOffset += bytesToAdd;
            totalSize += bytesToAdd;

            if (bufferOffset >= this.multipartPartSize) {
              await this.uploadPart(UploadId, partNumber, buffer, parts, signal);
              partNumber++;
              buffer = new Uint8Array(this.multipartPartSize);
              bufferOffset = 0;
            }
          }
        }
      } else if (start > 0) {
        // File is empty but start > 0, need to pad with zeros
        let paddingOffset = 0;
        while (paddingOffset < start) {
          const spaceInBuffer = this.multipartPartSize - bufferOffset;
          const bytesToAdd = Math.min(spaceInBuffer, start - paddingOffset);

          bufferOffset += bytesToAdd;
          paddingOffset += bytesToAdd;
          totalSize += bytesToAdd;

          if (bufferOffset >= this.multipartPartSize) {
            await this.uploadPart(UploadId, partNumber, buffer, parts, signal);
            partNumber++;
            buffer = new Uint8Array(this.multipartPartSize);
            bufferOffset = 0;
          }
        }
      }

      // Stream new data, buffering only one part at a time
      for await (const chunk of toBinaryAsyncIterable(data)) {
        if (signal?.aborted) {
          throw new Error("Operation aborted");
        }

        let chunkOffset = 0;

        while (chunkOffset < chunk.length) {
          const spaceInBuffer = this.multipartPartSize - bufferOffset;
          const bytesToCopy = Math.min(spaceInBuffer, chunk.length - chunkOffset);

          buffer.set(chunk.subarray(chunkOffset, chunkOffset + bytesToCopy), bufferOffset);
          bufferOffset += bytesToCopy;
          chunkOffset += bytesToCopy;
          bytesWritten += bytesToCopy;
          totalSize += bytesToCopy;

          // Upload part when buffer is full
          if (bufferOffset >= this.multipartPartSize) {
            await this.uploadPart(UploadId, partNumber, buffer, parts, signal);
            partNumber++;
            buffer = new Uint8Array(this.multipartPartSize);
            bufferOffset = 0;
          }
        }
      }

      // Upload remaining data in buffer (last part can be smaller than 5MB)
      if (bufferOffset > 0) {
        const lastPart = buffer.subarray(0, bufferOffset);
        await this.uploadPart(UploadId, partNumber, lastPart, parts, signal);
      }

      // Handle empty file case - S3 requires at least one part
      if (parts.length === 0) {
        await this.uploadPart(UploadId, 1, new Uint8Array(0), parts, signal);
      }

      // Complete multipart upload
      const completeCommand = new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.key,
        UploadId,
        MultipartUpload: { Parts: parts },
      });

      await this.client.send(completeCommand, { abortSignal: signal });

      this._size = totalSize;
      return bytesWritten;
    } catch (error) {
      // Abort on failure to clean up
      await this.abortMultipartUpload(UploadId);
      throw error;
    }
  }

  /**
   * Download a range of bytes from the S3 object.
   */
  private async downloadRange(
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (end <= start) {
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

    // Collect the streamed response into a single buffer
    const chunks: Uint8Array[] = [];
    for await (const chunk of streamBody(response.Body)) {
      chunks.push(chunk);
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

  /**
   * Upload a single part and record it in the parts array.
   */
  private async uploadPart(
    uploadId: string,
    partNumber: number,
    data: Uint8Array,
    parts: { ETag: string; PartNumber: number }[],
    signal?: AbortSignal,
  ): Promise<void> {
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: this.key,
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: data,
      ContentLength: data.length,
    });

    const { ETag } = await this.client.send(command, { abortSignal: signal });

    if (ETag) {
      parts.push({ ETag, PartNumber: partNumber });
    }
  }

  /**
   * Abort a multipart upload, ignoring errors.
   */
  private async abortMultipartUpload(uploadId: string): Promise<void> {
    const command = new AbortMultipartUploadCommand({
      Bucket: this.bucket,
      Key: this.key,
      UploadId: uploadId,
    });

    await this.client.send(command).catch(() => {
      // Ignore abort errors
    });
  }

  /**
   * Random access read from S3 object using HTTP Range header.
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

    // Calculate actual bytes to read
    let len = Math.min(length, buffer.length - offset);
    len = Math.min(len, this._size - position);
    len = Math.max(0, len);

    if (len === 0) {
      return 0;
    }

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.key,
      Range: `bytes=${position}-${position + len - 1}`,
    });

    const response = await this.client.send(command);

    if (!response.Body) {
      return 0;
    }

    // Collect the streamed response into a single buffer
    const chunks: Uint8Array[] = [];
    for await (const chunk of streamBody(response.Body)) {
      chunks.push(chunk);
    }

    if (chunks.length === 0) return 0;

    // Merge chunks if needed
    let data: Uint8Array;
    if (chunks.length === 1) {
      data = chunks[0];
    } else {
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      data = new Uint8Array(totalLength);
      let pos = 0;
      for (const chunk of chunks) {
        data.set(chunk, pos);
        pos += chunk.length;
      }
    }

    const bytesToCopy = Math.min(data.length, len);
    buffer.set(data.subarray(0, bytesToCopy), offset);
    return bytesToCopy;
  }
}
