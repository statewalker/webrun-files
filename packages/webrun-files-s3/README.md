# @statewalker/webrun-files-s3

S3 implementation of the `FilesApi` interface from `@statewalker/webrun-files`.

## Overview

This package provides a `FilesApi` implementation that stores files in Amazon S3 or S3-compatible object storage services (MinIO, DigitalOcean Spaces, Backblaze B2, Cloudflare R2, etc.). It maps filesystem-like operations to S3 API calls, providing:

- **Virtual directory structure** using key prefixes
- **Range reads** via HTTP Range headers for efficient partial access
- **Server-side copy** for copy/move operations (no data transfer through client)

## Installation

```bash
npm install @statewalker/webrun-files-s3 @statewalker/webrun-files @aws-sdk/client-s3
```

## Usage

### Basic Usage

```typescript
import { S3Client } from '@aws-sdk/client-s3';
import { S3FilesApi } from '@statewalker/webrun-files-s3';
import { readText, writeText } from '@statewalker/webrun-files';

// Create S3 client
const s3Client = new S3Client({
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'YOUR_ACCESS_KEY',
    secretAccessKey: 'YOUR_SECRET_KEY',
  },
});

// Create S3-backed files API
const files = new S3FilesApi({
  client: s3Client,
  bucket: 'my-bucket',
  prefix: 'my-app/data', // optional key prefix
});

// Write a file
await writeText(files, '/docs/hello.txt', 'Hello, S3!');

// Read a file
const content = await readText(files, '/docs/hello.txt');
console.log(content); // "Hello, S3!"

// List directory contents
for await (const entry of files.list('/docs')) {
  console.log(entry.name, entry.kind, entry.size);
}
```

### With S3-Compatible Storage (MinIO)

```typescript
import { S3Client } from '@aws-sdk/client-s3';
import { S3FilesApi } from '@statewalker/webrun-files-s3';

const s3Client = new S3Client({
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
  },
  forcePathStyle: true, // Required for MinIO
});

const files = new S3FilesApi({
  client: s3Client,
  bucket: 'my-bucket',
});
```

### With AWS IAM Roles (EC2, Lambda, ECS)

```typescript
import { S3Client } from '@aws-sdk/client-s3';
import { S3FilesApi } from '@statewalker/webrun-files-s3';

// Credentials are automatically loaded from environment/IAM role
const s3Client = new S3Client({ region: 'us-east-1' });

const files = new S3FilesApi({
  client: s3Client,
  bucket: 'my-bucket',
});
```

## API Reference

### S3FilesApi

```typescript
interface S3FilesApiOptions {
  /** Pre-configured S3Client instance. */
  client: S3Client;
  /** S3 bucket name. */
  bucket: string;
  /** Optional key prefix (acts as root directory). */
  prefix?: string;
}

class S3FilesApi implements FilesApi {
  constructor(options: S3FilesApiOptions);

  // All FilesApi methods
  read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array>;
  write(path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void>;
  mkdir(path: string): Promise<void>;
  list(path: string, options?: ListOptions): AsyncIterable<FileInfo>;
  stats(path: string): Promise<FileStats | undefined>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<boolean>;
  move(source: string, target: string): Promise<boolean>;
  copy(source: string, target: string): Promise<boolean>;
}
```

## How It Works

### Path to Key Mapping

Virtual paths are mapped to S3 keys by combining the optional prefix with the path:

```
prefix: "my-app/data"
path:   "/docs/file.txt"
key:    "my-app/data/docs/file.txt"
```

### Directory Listing

S3 doesn't have real directories, but this implementation simulates them using:

- **ListObjectsV2** with `Delimiter="/"` to get "subdirectories" via `CommonPrefixes`
- Files are returned from `Contents`

```typescript
// List /docs with prefix "my-app"
// S3 request: ListObjectsV2(Prefix="my-app/docs/", Delimiter="/")
for await (const entry of files.list('/docs')) {
  // entry.kind is "file" or "directory"
}
```

### Reading Files

Reads use `GetObject` with HTTP Range headers for efficient partial access:

```typescript
// Read bytes 1000-1499 from a file
for await (const chunk of files.read('/large-file.bin', { start: 1000, length: 500 })) {
  // Streams directly from S3, no full file download
}
```

### Writing Files

Writes use `PutObject` to upload content:

```typescript
await writeText(files, '/data/file.txt', 'content');
// S3 request: PutObject(Bucket, Key, Body)
```

### Copy and Move

- **Copy** uses `CopyObject` for single files or multiple `CopyObject` calls for directories
- **Move** is implemented as copy + delete
- Both operations happen server-side without transferring data through the client

### Directory Creation

S3 directories are implicit (they exist if files exist within them). The `mkdir()` method creates an empty directory marker object:

```typescript
await files.mkdir('/empty-dir');
// Creates object: "prefix/empty-dir/" with 0 bytes
```

## S3-Compatible Storage

This implementation works with any S3-compatible storage:

| Service | Configuration Notes |
|---------|---------------------|
| **AWS S3** | Standard configuration |
| **MinIO** | Set `forcePathStyle: true` |
| **DigitalOcean Spaces** | Use `endpoint: "https://<region>.digitaloceanspaces.com"` |
| **Backblaze B2** | Use S3-compatible endpoint |
| **Cloudflare R2** | Use account-specific endpoint |
| **Wasabi** | Use region-specific endpoint |

## Testing

Tests use [testcontainers](https://github.com/testcontainers/testcontainers-node) with MinIO:

```typescript
import { MinioContainer } from '@testcontainers/minio';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { S3FilesApi } from '@statewalker/webrun-files-s3';

const minioContainer = await new MinioContainer().start();

const s3Client = new S3Client({
  endpoint: minioContainer.getConnectionUrl(),
  region: 'us-east-1',
  credentials: {
    accessKeyId: minioContainer.getUsername(),
    secretAccessKey: minioContainer.getPassword(),
  },
  forcePathStyle: true,
});

await s3Client.send(new CreateBucketCommand({ Bucket: 'test-bucket' }));

const files = new S3FilesApi({
  client: s3Client,
  bucket: 'test-bucket',
});
```

## License

MIT
