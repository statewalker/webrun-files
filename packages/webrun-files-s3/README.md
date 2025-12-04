# @statewalker/webrun-files-s3

S3-backed implementation of the `IFilesApi` interface from `@statewalker/webrun-files`.

## Installation

```bash
npm install @statewalker/webrun-files-s3 @statewalker/webrun-files @aws-sdk/client-s3
```

## Usage

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
  prefix: "my-app/data", // optional
});

// Wrap with FilesApi for convenience methods
const filesApi = new FilesApi(s3FilesApi);

// Use the API
await filesApi.write("/docs/hello.txt", [new TextEncoder().encode("Hello!")]);
const content = await filesApi.readFile("/docs/hello.txt");
console.log(new TextDecoder().decode(content)); // "Hello!"
```

## Features

- Full `IFilesApi` implementation including `move()`, `copy()`, and `mkdir()`
- Multipart uploads for large files (>5MB)
- HTTP Range headers for efficient partial reads
- Compatible with S3-compatible storage (MinIO, etc.)
