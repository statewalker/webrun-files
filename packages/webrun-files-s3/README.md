# @statewalker/webrun-files-s3

## What it is

`S3FilesApi`, an implementation of `FilesApi` from `@statewalker/webrun-files` that stores files
as objects in an Amazon S3 bucket or any S3-compatible store (MinIO, RustFS, Cloudflare R2,
DigitalOcean Spaces, Backblaze B2, Wasabi). Paths become keys under an optional prefix.

## Why it exists

S3 has keys, not files and directories, and its API (ranges, multipart uploads, server-side copy,
delimited listings) is far from a file system's. This package maps the file operations onto it
once, with streaming in both directions, so code written against `FilesApi` runs on object storage
unchanged.

## How to use

```bash
pnpm add @statewalker/webrun-files-s3 @statewalker/webrun-files @aws-sdk/client-s3
```

`@aws-sdk/client-s3` (`^3.1032.0`) is a peer dependency: you create and configure the `S3Client`
(credentials, region, endpoint) and pass it in.

One entry point, `@statewalker/webrun-files-s3`: ESM (`dist/esm/index.js`), CommonJS
(`dist/cjs/index.cjs`), types (`dist/index.d.ts`); sources in `src/`. Runs wherever the AWS SDK v3
runs.

```typescript
interface S3FilesApiOptions {
  client: S3Client;            // a configured client
  bucket: string;
  prefix?: string;             // key prefix acting as the root; leading/trailing "/" are stripped
  multipartPartSize?: number;  // bytes per multipart part, default 5 MiB (the S3 minimum)
}
```

## Examples

### AWS

```typescript
import { S3Client } from '@aws-sdk/client-s3';
import { S3FilesApi } from '@statewalker/webrun-files-s3';
import { readText, writeText } from '@statewalker/webrun-files';

// Credentials come from the environment or the IAM role
const files = new S3FilesApi({
  client: new S3Client({ region: 'us-east-1' }),
  bucket: 'my-bucket',
  prefix: 'my-app/data',
});

await writeText(files, '/docs/hello.txt', 'Hello, S3!'); // key: my-app/data/docs/hello.txt
console.log(await readText(files, '/docs/hello.txt'));

for await (const entry of files.list('/docs')) {
  console.log(entry.name, entry.kind, entry.kind === 'file' ? entry.size : '');
}
```

### An S3-compatible server on a custom endpoint

```typescript
const files = new S3FilesApi({
  client: new S3Client({
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    forcePathStyle: true, // MinIO, RustFS and most self-hosted servers need path-style URLs
  }),
  bucket: 'my-bucket',
});
```

### Stream a large upload and a range read

```typescript
await files.write('/data/large.bin', generateChunks()); // AsyncIterable<Uint8Array>

for await (const chunk of files.read('/data/large.bin', { start: 1000, length: 500 })) {
  // bytes 1000-1499, fetched with a Range header
}
```

## Internals

### How calls map to S3

```
path "/docs/file.txt" + prefix "my-app/data"  ->  key "my-app/data/docs/file.txt"
```

| Call | S3 requests |
| --- | --- |
| `read` | `GetObject`, with `Range: bytes=start-end` when `start`/`length` are given; streams the body |
| `write` | under 5 MiB: one `PutObject`; otherwise `CreateMultipartUpload` + one `UploadPart` per `multipartPartSize` + `CompleteMultipartUpload`; `AbortMultipartUpload` on any error |
| `mkdir` | `PutObject` of an empty `dir/` marker key |
| `list` | `ListObjectsV2` with `Delimiter: "/"` (or none when recursive), `StartAfter` for `after` |
| `copy` | `CopyObject` per object, server-side |
| `move` | `copy`, then `remove` |
| `remove` | `DeleteObject` per key under the path |

A write buffers at most one part, so memory stays at about `multipartPartSize` whatever the file
size.

### How directories are represented

- A **common prefix is a directory**: `{ kind: "directory" }` and nothing more. There is no size or
  time for something that exists only in key names.
- **A key ending in `/` is a directory**, such as the marker `mkdir()` writes so an empty
  directory is visible; it is skipped when reading files. Every other key is a file, and an empty
  object is the file variant with `size: 0`.
- With `{ recursive: true }` only files are yielded. Directories, including empty ones created by
  `mkdir()`, do not appear in a recursive listing.

### Why the non-recursive listing holds entries back

S3 lists keys in UTF-8 byte order, which is the `FilesApi` order for files. But a directory `a`
arrives as the common prefix `a/`, after keys such as `a-x` and `a.txt` that must follow it,
because `-` and `.` sort before `/`. The listing therefore buffers the few entries a directory still
to come could precede, across page boundaries, and releases them in order. When a key `a` and keys
under `a/` both exist, `/a` is listed once, as the file, the same answer `stats()` gives.

### What breaks, and how it looks

- **`move` and directory `copy` are not atomic.** They are many `CopyObject` and `DeleteObject`
  calls; a failure midway leaves some objects copied and the source partly removed.
- **Writing zero chunks creates nothing.** `write(path, [])` sends no request, so the path does not
  exist afterwards. Pass `[new Uint8Array(0)]` to create an empty file.
- **Single-request copies.** Each object is copied with one `CopyObject`, which S3 limits to 5 GB
  per object.
- **Errors other than not-found propagate.** `read` treats `404` and `416` as an empty read; any
  other SDK error (access denied, bad credentials, wrong region) is thrown as the SDK's error.

### Testing

`pnpm test` runs only unit tests (a fake client exercises listing order across pages).
`pnpm test:integration` needs Docker: it starts
[RustFS](https://github.com/rustfs/rustfs) through testcontainers (`rustfs/rustfs:latest`, override
with `RUSTFS_IMAGE`) and runs the shared `createFilesApiTests` and `createBigFilesApiTests` suites
against it.

### Dependencies

`@statewalker/webrun-files` for the types and path helpers; `@aws-sdk/client-s3` as a peer, so the
application controls the SDK version and shares one client.

## License

MIT
