/**
 * S3 implementation of FilesApi
 *
 * Provides a filesystem-like interface over S3 object storage.
 */

import type { S3Client } from "@aws-sdk/client-s3";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import { basename, normalizePath } from "@statewalker/webrun-files";

/** Default part size for multipart uploads: 5MB (S3 minimum) */
const DEFAULT_PART_SIZE = 5 * 1024 * 1024;

/** Threshold for using multipart upload: 5MB */
const MULTIPART_THRESHOLD = 5 * 1024 * 1024;

export interface S3FilesApiOptions {
  /**
   * Pre-configured S3Client instance.
   */
  client: S3Client;

  /**
   * S3 bucket name.
   */
  bucket: string;

  /**
   * Optional key prefix (acts as root directory).
   * @example "projects/my-app/data"
   */
  prefix?: string;

  /**
   * Part size for multipart uploads in bytes.
   * S3 requires minimum 5MB for all parts except the last.
   * @default 5242880 (5MB)
   */
  multipartPartSize?: number;
}

/**
 * S3 filesystem implementation of FilesApi.
 *
 * Provides a filesystem-like interface over S3 object storage.
 * Works with AWS S3 and S3-compatible services.
 */
export class S3FilesApi implements FilesApi {
  private client: S3Client;
  private bucket: string;
  private prefix: string;
  private partSize: number;

  constructor(options: S3FilesApiOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
    this.prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
    this.partSize = options.multipartPartSize ?? DEFAULT_PART_SIZE;
  }

  private resolveKey(path: string): string {
    const normalized = normalizePath(path);
    const relativePath = normalized.startsWith("/") ? normalized.substring(1) : normalized;

    if (this.prefix) {
      return relativePath ? `${this.prefix}/${relativePath}` : this.prefix;
    }
    return relativePath;
  }

  private keyToPath(key: string): string {
    let relativePath = key;
    if (this.prefix && key.startsWith(this.prefix)) {
      relativePath = key.substring(this.prefix.length);
      if (relativePath.startsWith("/")) {
        relativePath = relativePath.substring(1);
      }
    }
    return `/${relativePath}`;
  }

  async *read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array> {
    const key = this.resolveKey(path);

    try {
      const start = options?.start ?? 0;
      const length = options?.length;

      // Return empty if length is explicitly 0
      if (length === 0) {
        return;
      }

      let range: string | undefined;
      if (start > 0 || length !== undefined) {
        const end = length !== undefined ? start + length - 1 : "";
        range = `bytes=${start}-${end}`;
      }

      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: range,
      });

      const response = await this.client.send(command);

      if (response.Body) {
        const stream = response.Body as AsyncIterable<Uint8Array>;
        for await (const chunk of stream) {
          yield chunk;
        }
      }
    } catch (error: unknown) {
      const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      // Handle NotFound (404) and InvalidRange (416) - return empty
      if (
        err.name === "NotFound" ||
        err.name === "InvalidRange" ||
        err.$metadata?.httpStatusCode === 404 ||
        err.$metadata?.httpStatusCode === 416
      ) {
        return;
      }
      throw error;
    }
  }

  async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const key = this.resolveKey(path);

    // Buffer for accumulating small writes
    let buffer: Uint8Array[] = [];
    let bufferSize = 0;
    let uploadId: string | undefined;
    const parts: { ETag: string; PartNumber: number }[] = [];
    let partNumber = 1;

    const flushPart = async (isLast: boolean) => {
      if (buffer.length === 0) return;

      const partLength = buffer.reduce((sum, c) => sum + c.length, 0);
      const partBuffer = new Uint8Array(partLength);
      let offset = 0;
      for (const chunk of buffer) {
        partBuffer.set(chunk, offset);
        offset += chunk.length;
      }
      buffer = [];
      bufferSize = 0;

      // For small files (under threshold) and this is the only/last part, use simple PutObject
      if (!uploadId && isLast && partLength < MULTIPART_THRESHOLD) {
        const command = new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: partBuffer,
          ContentLength: partLength,
        });
        await this.client.send(command);
        return;
      }

      // Start multipart upload if not already started
      if (!uploadId) {
        const createCommand = new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
        });
        const { UploadId } = await this.client.send(createCommand);
        if (!UploadId) {
          throw new Error("Failed to create multipart upload");
        }
        uploadId = UploadId;
      }

      // Upload the part
      const uploadCommand = new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: partBuffer,
      });

      const response = await this.client.send(uploadCommand);
      if (!response.ETag) {
        throw new Error(`Failed to upload part ${partNumber}`);
      }

      parts.push({
        ETag: response.ETag,
        PartNumber: partNumber,
      });
      partNumber++;
    };

    try {
      // Process chunks as they arrive
      for await (const chunk of content) {
        buffer.push(chunk);
        bufferSize += chunk.length;

        // Flush when buffer reaches part size
        if (bufferSize >= this.partSize) {
          await flushPart(false);
        }
      }

      // Flush remaining data
      await flushPart(true);

      // Complete multipart upload if one was started
      if (uploadId) {
        const completeCommand = new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber),
          },
        });
        await this.client.send(completeCommand);
      }
    } catch (error) {
      // Abort multipart upload on error
      if (uploadId) {
        const abortCommand = new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        });

        try {
          await this.client.send(abortCommand);
        } catch {
          // Ignore abort errors
        }
      }

      throw error;
    }
  }

  async mkdir(path: string): Promise<void> {
    const key = this.resolveKey(path);
    const dirKey = key.endsWith("/") ? key : `${key}/`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: dirKey,
      Body: new Uint8Array(0),
      ContentLength: 0,
    });

    await this.client.send(command);
  }

  async *list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    const recursive = options?.recursive ?? false;
    const prefix = this.resolveKey(path);
    const normalizedPrefix = prefix ? `${prefix}/` : this.prefix ? `${this.prefix}/` : "";

    let continuationToken: string | undefined;

    do {
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: normalizedPrefix,
        Delimiter: recursive ? undefined : "/",
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      });

      const response = await this.client.send(command);

      if (!recursive && response.CommonPrefixes) {
        for (const cpPrefix of response.CommonPrefixes) {
          if (!cpPrefix.Prefix) continue;

          const dirKey = cpPrefix.Prefix.endsWith("/")
            ? cpPrefix.Prefix.slice(0, -1)
            : cpPrefix.Prefix;

          const dirPath = this.keyToPath(dirKey);

          yield {
            kind: "directory",
            name: basename(dirPath),
            path: dirPath,
            lastModified: 0,
          };
        }
      }

      if (response.Contents) {
        for (const obj of response.Contents) {
          if (!obj.Key) continue;
          if (obj.Key === normalizedPrefix) continue;
          if (`${obj.Key}/` === normalizedPrefix) continue;
          if (obj.Key.endsWith("/")) continue;

          const filePath = this.keyToPath(obj.Key);

          yield {
            kind: "file",
            name: basename(filePath),
            path: filePath,
            size: obj.Size ?? 0,
            lastModified: obj.LastModified?.getTime() ?? 0,
          };
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);
  }

  async stats(path: string): Promise<FileStats | undefined> {
    const normalized = normalizePath(path);
    const key = this.resolveKey(path);

    if (normalized === "/") {
      return {
        kind: "directory",
        lastModified: 0,
      };
    }

    // Try as file first
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const response = await this.client.send(command);

      return {
        kind: "file",
        size: response.ContentLength ?? 0,
        lastModified: response.LastModified?.getTime() ?? 0,
      };
    } catch (error: unknown) {
      const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err.name !== "NotFound" && err.$metadata?.httpStatusCode !== 404) {
        throw error;
      }
    }

    // Check if it's a virtual directory
    const prefix = key ? `${key}/` : "";
    const listCommand = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
      MaxKeys: 1,
    });

    const listResponse = await this.client.send(listCommand);

    if (
      (listResponse.Contents && listResponse.Contents.length > 0) ||
      (listResponse.CommonPrefixes && listResponse.CommonPrefixes.length > 0)
    ) {
      return {
        kind: "directory",
        lastModified: 0,
      };
    }

    return undefined;
  }

  async exists(path: string): Promise<boolean> {
    const stats = await this.stats(path);
    return stats !== undefined;
  }

  async remove(path: string): Promise<boolean> {
    const key = this.resolveKey(path);

    // First try to delete as a single object
    try {
      const headCommand = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.client.send(headCommand);

      const deleteCommand = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.client.send(deleteCommand);
      return true;
    } catch (error: unknown) {
      const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err.name !== "NotFound" && err.$metadata?.httpStatusCode !== 404) {
        throw error;
      }
    }

    // Delete all objects under this prefix (directory)
    const prefix = key ? `${key}/` : "";
    const keysToDelete: string[] = [];

    let continuationToken: string | undefined;

    do {
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });

      const response = await this.client.send(listCommand);

      if (response.Contents) {
        for (const obj of response.Contents) {
          if (obj.Key) {
            keysToDelete.push(obj.Key);
          }
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    if (keysToDelete.length === 0) {
      return false;
    }

    for (const keyToDelete of keysToDelete) {
      const deleteCommand = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: keyToDelete,
      });

      await this.client.send(deleteCommand);
    }

    return true;
  }

  async move(source: string, target: string): Promise<boolean> {
    const copied = await this.copy(source, target);
    if (!copied) return false;
    return this.remove(source);
  }

  async copy(source: string, target: string): Promise<boolean> {
    const sourceKey = this.resolveKey(source);
    const targetKey = this.resolveKey(target);

    const sourceStats = await this.stats(source);
    if (!sourceStats) return false;

    if (sourceStats.kind === "file") {
      const command = new CopyObjectCommand({
        Bucket: this.bucket,
        Key: targetKey,
        CopySource: encodeURIComponent(`${this.bucket}/${sourceKey}`),
      });

      await this.client.send(command);
      return true;
    }

    // Copy directory (all objects under prefix)
    const sourcePrefix = `${sourceKey}/`;
    const targetPrefix = `${targetKey}/`;

    let continuationToken: string | undefined;
    let copied = false;

    do {
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: sourcePrefix,
        ContinuationToken: continuationToken,
      });

      const response = await this.client.send(listCommand);

      if (response.Contents) {
        for (const obj of response.Contents) {
          if (!obj.Key) continue;

          const relativePath = obj.Key.substring(sourcePrefix.length);
          const newKey = targetPrefix + relativePath;

          const copyCommand = new CopyObjectCommand({
            Bucket: this.bucket,
            Key: newKey,
            CopySource: encodeURIComponent(`${this.bucket}/${obj.Key}`),
          });

          await this.client.send(copyCommand);
          copied = true;
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return copied;
  }
}
