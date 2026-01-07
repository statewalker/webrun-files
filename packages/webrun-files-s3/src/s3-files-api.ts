/**
 * S3 implementation of IFilesApi
 *
 * Provides a filesystem-like interface over S3 object storage.
 * Supports all IFilesApi methods including the optional move, copy, and mkdir.
 */

import type { S3Client } from "@aws-sdk/client-s3";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type {
  CopyOptions,
  FileHandle,
  FileInfo,
  FileRef,
  IFilesApi,
  ListOptions,
} from "@statewalker/webrun-files";
import { basename, resolveFileRef } from "@statewalker/webrun-files";
import { S3FileHandle } from "./s3-file-handle.js";

export interface S3FilesApiOptions {
  /**
   * Pre-configured S3Client instance.
   * Allows full control over credentials, region, endpoint.
   */
  client: S3Client;

  /**
   * S3 bucket name.
   */
  bucket: string;

  /**
   * Optional key prefix (acts as root directory).
   * All paths will be relative to this prefix.
   * @example "projects/my-app/data"
   */
  prefix?: string;

  /**
   * Minimum part size for multipart uploads (5MB minimum for S3).
   * @default 5 * 1024 * 1024 (5MB)
   */
  multipartPartSize?: number;
}

/**
 * S3 filesystem implementation of IFilesApi.
 *
 * Provides a filesystem-like interface over S3 object storage.
 * Works with AWS S3 and S3-compatible services (MinIO, Backblaze B2,
 * Cloudflare R2, DigitalOcean Spaces, etc.).
 *
 * Key design decisions:
 * - Directories are virtual (simulated using key prefixes with "/" delimiter)
 * - The prefix option allows scoping all operations to a "subdirectory"
 * - Large files use multipart uploads for memory efficiency
 * - Server-side copy is used for copy/move operations (no data transfer through client)
 */
export class S3FilesApi implements IFilesApi {
  private client: S3Client;
  private bucket: string;
  /** Key prefix that acts as the virtual root directory. */
  private prefix: string;
  /** Part size for multipart uploads (5MB minimum required by S3). */
  private multipartPartSize: number;

  /**
   * Creates an S3FilesApi instance.
   * @param options - Configuration including S3 client, bucket, and optional prefix.
   */
  constructor(options: S3FilesApiOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
    // Normalize prefix: remove leading/trailing slashes for consistent key construction
    this.prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
    this.multipartPartSize = options.multipartPartSize ?? 5 * 1024 * 1024;
  }

  /**
   * Converts a virtual path to an S3 key.
   * @example resolveKey("/docs/file.txt") => "prefix/docs/file.txt"
   */
  private resolveKey(file: FileRef): string {
    const normalized = resolveFileRef(file);
    // Remove leading slash and combine with prefix
    const relativePath = normalized.startsWith("/") ? normalized.substring(1) : normalized;

    if (this.prefix) {
      return relativePath ? `${this.prefix}/${relativePath}` : this.prefix;
    }
    return relativePath;
  }

  /**
   * Converts an S3 key back to a virtual path.
   */
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

  /**
   * Lists objects in a virtual directory.
   *
   * Uses S3's delimiter feature to simulate directory listing.
   * When not recursive, S3 returns CommonPrefixes for subdirectories
   * (objects that share a common prefix up to the next "/").
   *
   * Handles pagination automatically using ContinuationToken.
   *
   * @inheritdoc
   */
  async *list(file: FileRef, options: ListOptions = {}): AsyncGenerator<FileInfo> {
    const { recursive = false } = options;
    const prefix = this.resolveKey(file);
    // For root path ("/"), resolveKey returns empty string or prefix
    // We need to ensure proper prefix handling
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

      // Yield directories (CommonPrefixes)
      if (!recursive && response.CommonPrefixes) {
        for (const cpPrefix of response.CommonPrefixes) {
          if (!cpPrefix.Prefix) continue;

          // Remove trailing slash
          const dirKey = cpPrefix.Prefix.endsWith("/")
            ? cpPrefix.Prefix.slice(0, -1)
            : cpPrefix.Prefix;

          const path = this.keyToPath(dirKey);

          yield {
            kind: "directory",
            name: basename(path),
            path,
            lastModified: 0,
          };
        }
      }

      // Yield files (Contents)
      if (response.Contents) {
        for (const obj of response.Contents) {
          if (!obj.Key) continue;

          // Skip if it's just the prefix itself (directory marker)
          if (obj.Key === normalizedPrefix) continue;
          if (`${obj.Key}/` === normalizedPrefix) continue;

          // Skip directory markers (keys ending with /)
          if (obj.Key.endsWith("/")) continue;

          const path = this.keyToPath(obj.Key);

          yield {
            kind: "file",
            name: basename(path),
            path,
            size: obj.Size ?? 0,
            lastModified: obj.LastModified?.getTime() ?? 0,
          };
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);
  }

  /**
   * Gets object metadata using HEAD request.
   *
   * First tries to get the object as a file (HEAD request).
   * If not found, checks if it's a virtual directory by listing
   * objects with that prefix.
   *
   * Note: S3 doesn't store directory metadata, so directories
   * always return lastModified: 0.
   *
   * @inheritdoc
   */
  async stats(file: FileRef): Promise<FileInfo | undefined> {
    const normalized = resolveFileRef(file);
    const key = this.resolveKey(file);

    // Handle root directory
    if (normalized === "/") {
      return {
        kind: "directory",
        name: "",
        path: "/",
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
        name: basename(normalized),
        path: normalized,
        size: response.ContentLength ?? 0,
        lastModified: response.LastModified?.getTime() ?? 0,
        type: response.ContentType,
      };
    } catch (error: unknown) {
      const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err.name !== "NotFound" && err.$metadata?.httpStatusCode !== 404) {
        throw error;
      }
    }

    // Check if it's a virtual directory by listing with prefix
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
        name: basename(normalized),
        path: normalized,
        lastModified: 0,
      };
    }

    return undefined;
  }

  /**
   * Deletes an object or all objects under a prefix (directory).
   *
   * First tries to delete as a single object. If not found, lists
   * all objects under the prefix and deletes them one by one.
   *
   * Uses individual DeleteObject calls instead of DeleteObjects batch
   * for better compatibility with S3-compatible services like MinIO.
   *
   * @inheritdoc
   */
  async remove(file: FileRef): Promise<boolean> {
    const key = this.resolveKey(file);

    // First try to delete as a single object
    try {
      // Check if object exists
      const headCommand = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.client.send(headCommand);

      // Object exists, delete it
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
      // Object doesn't exist, continue to check if it's a directory
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

    // Delete objects one by one (more compatible with MinIO and other S3-compatible stores)
    for (const keyToDelete of keysToDelete) {
      const deleteCommand = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: keyToDelete,
      });

      await this.client.send(deleteCommand);
    }

    return true;
  }

  /**
   * Opens an S3 object for random access.
   *
   * Returns an S3FileHandle that provides read/write operations.
   * The object is created lazily on first write if it doesn't exist.
   *
   * Note: Unlike traditional filesystems, S3 objects are immutable.
   * Writes require re-uploading the entire object, though the S3FileHandle
   * uses UploadPartCopy to preserve existing content efficiently.
   *
   * @inheritdoc
   */
  async open(file: FileRef): Promise<FileHandle> {
    const key = this.resolveKey(file);

    let size = 0;

    // Get current size if object exists
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const response = await this.client.send(command);
      size = response.ContentLength ?? 0;
    } catch (error: unknown) {
      const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err.name !== "NotFound" && err.$metadata?.httpStatusCode !== 404) {
        throw error;
      }
      // Object doesn't exist, will be created on write
    }

    return new S3FileHandle({
      client: this.client,
      bucket: this.bucket,
      key,
      size,
      multipartPartSize: this.multipartPartSize,
    });
  }

  /**
   * Moves an object using server-side Copy + Delete.
   *
   * S3 doesn't have a native move operation, so this is implemented
   * as copy + delete. The copy uses S3's server-side copy which doesn't
   * transfer data through the client.
   *
   * @inheritdoc
   */
  async move(source: FileRef, target: FileRef): Promise<boolean> {
    const copied = await this.copy(source, target);
    if (!copied) return false;

    return this.remove(source);
  }

  /**
   * Copies an object or directory using S3 CopyObject.
   *
   * Uses S3's server-side copy which copies data directly within S3
   * without transferring through the client. This is efficient for
   * large files and directories.
   *
   * For directories, copies all objects with the source prefix to
   * the target prefix.
   *
   * @inheritdoc
   */
  async copy(source: FileRef, target: FileRef, options: CopyOptions = {}): Promise<boolean> {
    const sourceKey = this.resolveKey(source);
    const targetKey = this.resolveKey(target);
    const { recursive = true } = options;

    // Check if source is a file
    const sourceInfo = await this.stats(source);
    if (!sourceInfo) return false;

    if (sourceInfo.kind === "file") {
      // Copy single object
      const command = new CopyObjectCommand({
        Bucket: this.bucket,
        Key: targetKey,
        CopySource: encodeURIComponent(`${this.bucket}/${sourceKey}`),
      });

      await this.client.send(command);
      return true;
    }

    // Copy directory (all objects under prefix)
    if (!recursive) {
      return false;
    }

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

  /**
   * Creates a directory marker in S3.
   *
   * S3 doesn't have real directories, but some tools (AWS Console,
   * s3cmd, etc.) expect a zero-byte object with trailing slash as
   * a directory marker. We create this marker for compatibility.
   *
   * Note: Directories also exist implicitly when files are created
   * under them, so mkdir() is optional for most use cases.
   *
   * @inheritdoc
   */
  async mkdir(file: FileRef): Promise<void> {
    // For S3, directories don't really need to be created explicitly
    // They exist implicitly when files exist inside them
    // But we create an empty object as a marker for compatibility
    const key = this.resolveKey(file);
    const dirKey = key.endsWith("/") ? key : `${key}/`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: dirKey,
      Body: new Uint8Array(0),
      ContentLength: 0,
    });

    await this.client.send(command);
  }
}
