# @statewalker/webrun-files-s3

S3-backed implementation of the `IFilesApi` interface from `@statewalker/webrun-files`.

## Overview

This package provides an `IFilesApi` implementation that stores files in Amazon S3 or S3-compatible object storage services (MinIO, DigitalOcean Spaces, Backblaze B2, etc.). It maps filesystem-like operations to S3 API calls, providing:

- **Virtual directory structure** using key prefixes
- **Streaming reads** with HTTP Range headers for efficient partial access
- **Streaming multipart uploads** for large files without buffering entirely in memory
- **Copy operations** using S3's server-side copy (no data transfer through client)

## Installation

```bash
npm install @statewalker/webrun-files-s3 @statewalker/webrun-files @aws-sdk/client-s3
```

## Usage

### Basic Usage

```typescript
import { S3Client } from "@aws-sdk/client-s3";
import { FilesApi } from "@statewalker/webrun-files";
import { S3FilesApi } from "@statewalker/webrun-files-s3";

// Create S3 client
const s3Client = new S3Client({
  region: "us-east-1",
  credentials: {
    accessKeyId: "YOUR_ACCESS_KEY",
    secretAccessKey: "YOUR_SECRET_KEY",
  },
});

// Create S3-backed files API
const s3FilesApi = new S3FilesApi({
  client: s3Client,
  bucket: "my-bucket",
  prefix: "my-app/data", // optional key prefix
});

// Wrap with FilesApi for convenience methods
const api = new FilesApi(s3FilesApi);

// Write a file
await api.write("/docs/hello.txt", [
  new TextEncoder().encode("Hello, S3!")
]);

// Read a file
const content = await api.readFile("/docs/hello.txt");
console.log(new TextDecoder().decode(content)); // "Hello, S3!"

// List directory contents
for await (const entry of api.list("/docs")) {
  console.log(entry.name, entry.kind, entry.size);
}
```

### With S3-Compatible Storage (MinIO)

```typescript
import { S3Client } from "@aws-sdk/client-s3";
import { S3FilesApi } from "@statewalker/webrun-files-s3";
import { FilesApi } from "@statewalker/webrun-files";

const s3Client = new S3Client({
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  credentials: {
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
  },
  forcePathStyle: true, // Required for MinIO
});

const s3FilesApi = new S3FilesApi({
  client: s3Client,
  bucket: "my-bucket",
});

const api = new FilesApi(s3FilesApi);
```

### With AWS IAM Roles (EC2, Lambda, ECS)

```typescript
import { S3Client } from "@aws-sdk/client-s3";
import { S3FilesApi } from "@statewalker/webrun-files-s3";

// Credentials are automatically loaded from environment/IAM role
const s3Client = new S3Client({ region: "us-east-1" });

const s3FilesApi = new S3FilesApi({
  client: s3Client,
  bucket: "my-bucket",
});
```

### Random Access with FileHandle

```typescript
const api = new FilesApi(s3FilesApi);

// Open a file for random access
const handle = await api.open("/large-file.bin");

console.log("File size:", handle.size);

// Read a specific range (uses HTTP Range header)
for await (const chunk of handle.createReadStream({ start: 1000, end: 2000 })) {
  console.log("Chunk:", chunk.length);
}

// Append data
await handle.appendFile([new TextEncoder().encode(" - appended")]);

await handle.close();
```

## Configuration

### S3FilesApiOptions

```typescript
interface S3FilesApiOptions {
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
   * Minimum part size for multipart uploads.
   * S3 requires minimum 5MB for all parts except the last.
   * @default 5 * 1024 * 1024 (5MB)
   */
  multipartPartSize?: number;
}
```

## API Reference

### S3FilesApi

Main class implementing `IFilesApi` for S3 storage.

```typescript
class S3FilesApi implements IFilesApi {
  constructor(options: S3FilesApiOptions);

  // Core IFilesApi methods
  list(file: FileRef, options?: ListOptions): AsyncGenerator<FileInfo>;
  stats(file: FileRef): Promise<FileInfo | undefined>;
  remove(file: FileRef): Promise<boolean>;
  open(file: FileRef): Promise<FileHandle>;

  // Optional methods (all implemented)
  mkdir(file: FileRef): Promise<void>;
  move(source: FileRef, target: FileRef): Promise<boolean>;
  copy(source: FileRef, target: FileRef, options?: CopyOptions): Promise<boolean>;
}
```

### S3FileHandle

File handle class for random access operations on S3 objects.

```typescript
class S3FileHandle implements FileHandle {
  readonly size: number;

  close(): Promise<void>;
  appendFile(data: BinaryStream, options?: AppendOptions): Promise<number>;
  createReadStream(options?: ReadStreamOptions): AsyncGenerator<Uint8Array>;
  createWriteStream(data: BinaryStream, options?: WriteStreamOptions): Promise<number>;
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
for await (const entry of api.list("/docs")) {
  // entry.kind is "file" or "directory"
}
```

### Reading Files

Reads use `GetObject` with HTTP Range headers for efficient partial access:

```typescript
// Read bytes 1000-1999 from a file
const handle = await api.open("/large-file.bin");
for await (const chunk of handle.createReadStream({ start: 1000, end: 2000 })) {
  // Streams directly from S3, no full file download
}
```

### Writing Files

Since S3 objects are immutable, writes use streaming multipart upload:

1. **CreateMultipartUpload** - Start the upload
2. **UploadPart** - Upload each 5MB+ chunk as it arrives
3. **CompleteMultipartUpload** - Finalize

For partial writes (preserving content before a position):

1. **UploadPartCopy** - Copy existing data as parts (no download needed)
2. **UploadPart** - Upload new data
3. **CompleteMultipartUpload** - Finalize

This approach:
- Buffers only one 5MB part at a time
- Uses server-side copy to preserve existing content
- Supports files of any size

### Copy and Move

- **Copy** uses `CopyObject` for single files or multiple `CopyObject` calls for directories
- **Move** is implemented as copy + delete
- Both operations happen server-side without transferring data through the client

### Directory Creation

S3 directories are implicit (they exist if files exist within them). The `mkdir()` method creates an empty directory marker object:

```typescript
await api.mkdir("/empty-dir");
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

## Performance Considerations

- **Multipart threshold**: Files larger than 5MB use multipart upload
- **Part size**: Default 5MB per part (configurable via `multipartPartSize`)
- **Range reads**: Always use `createReadStream({ start, end })` for partial reads
- **Server-side copy**: Copy/move operations don't transfer data through client
- **Pagination**: Directory listings handle pagination automatically

## Testing

Tests use [testcontainers](https://github.com/testcontainers/testcontainers-node) with MinIO:

```typescript
import { MinioContainer } from "@testcontainers/minio";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { S3FilesApi } from "@statewalker/webrun-files-s3";

const minioContainer = await new MinioContainer().start();

const s3Client = new S3Client({
  endpoint: minioContainer.getConnectionUrl(),
  region: "us-east-1",
  credentials: {
    accessKeyId: minioContainer.getUsername(),
    secretAccessKey: minioContainer.getPassword(),
  },
  forcePathStyle: true,
});

await s3Client.send(new CreateBucketCommand({ Bucket: "test-bucket" }));

const s3FilesApi = new S3FilesApi({
  client: s3Client,
  bucket: "test-bucket",
});
```

## License

MIT
