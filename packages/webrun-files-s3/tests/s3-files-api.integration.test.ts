/**
 * Integration tests for S3FilesApi against a real S3-compatible server.
 *
 * These require Docker and are NOT part of `pnpm test`. Run them with:
 *
 *     pnpm test:integration
 *
 * The server is RustFS (`rustfs/rustfs`), the same image the workspace uses
 * for local S3 storage, started per run via testcontainers.
 */

import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { readFile } from "@statewalker/webrun-files";
import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3FilesApi } from "../src/s3-files-api.js";

const RUSTFS_IMAGE = process.env.RUSTFS_IMAGE ?? "rustfs/rustfs:latest";
const ACCESS_KEY = "rustfsadmin";
const SECRET_KEY = "rustfsadmin";
const API_PORT = 9000;

describe("S3FilesApi with RustFS", () => {
  let container: StartedTestContainer;
  let s3Client: S3Client;
  const bucketName = "test-bucket";
  let testCounter = 0;

  beforeAll(async () => {
    container = await new GenericContainer(RUSTFS_IMAGE)
      .withExposedPorts(API_PORT)
      .withEnvironment({
        RUSTFS_ACCESS_KEY: ACCESS_KEY,
        RUSTFS_SECRET_KEY: SECRET_KEY,
        // Keep the server's own data inside the container; nothing is persisted.
        RUSTFS_VOLUMES: "/data",
      })
      // The image has no HTTP health endpoint that is stable across versions, so
      // wait for the API port to accept connections.
      .withWaitStrategy(Wait.forListeningPorts())
      .withStartupTimeout(120_000)
      .start();

    s3Client = new S3Client({
      endpoint: `http://${container.getHost()}:${container.getMappedPort(API_PORT)}`,
      region: "us-east-1",
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      forcePathStyle: true,
    });

    // Create test bucket
    await s3Client.send(
      new CreateBucketCommand({
        Bucket: bucketName,
      }),
    );
  }, 120000); // 2 minute timeout for container startup

  afterAll(async () => {
    s3Client?.destroy();
    await container?.stop();
  });

  createFilesApiTests("S3FilesApi", async () => {
    // Use unique prefix for each test to ensure isolation
    const prefix = `test-${testCounter++}-${Date.now()}`;

    const s3FilesApi = new S3FilesApi({
      client: s3Client,
      bucket: bucketName,
      prefix,
    });

    return {
      api: s3FilesApi,
      cleanup: async () => {
        // Cleanup by removing all objects with this prefix
        await s3FilesApi.remove("/");
      },
    };
  });

  describe("Multipart upload", () => {
    it("should upload files larger than 5MB using multipart upload", async () => {
      const prefix = `multipart-test-${Date.now()}`;
      const api = new S3FilesApi({
        client: s3Client,
        bucket: bucketName,
        prefix,
      });

      // Create a 6MB file (larger than 5MB threshold)
      const size = 6 * 1024 * 1024;
      const content = new Uint8Array(size);
      // Fill with pattern to verify data integrity
      for (let i = 0; i < size; i++) {
        content[i] = i % 256;
      }

      // Write the large file
      await api.write("/large-file.bin", [content]);

      // Verify file exists and has correct size
      const stats = await api.stats("/large-file.bin");
      expect(stats).toBeDefined();
      expect(stats?.kind).toBe("file");
      expect(stats?.size).toBe(size);

      // Read back and verify content
      const readContent = await readFile(api, "/large-file.bin");
      expect(readContent.length).toBe(size);

      // Verify data integrity
      for (let i = 0; i < size; i++) {
        if (readContent[i] !== i % 256) {
          throw new Error(`Data mismatch at position ${i}`);
        }
      }

      // Cleanup
      await api.remove("/");
    });

    it("should upload files in multiple parts with custom part size", async () => {
      const prefix = `multipart-parts-test-${Date.now()}`;
      // Use 5MB part size to get multiple parts for a 12MB file
      const api = new S3FilesApi({
        client: s3Client,
        bucket: bucketName,
        prefix,
        multipartPartSize: 5 * 1024 * 1024,
      });

      // Create a 12MB file (should result in 3 parts: 5MB + 5MB + 2MB)
      const size = 12 * 1024 * 1024;
      const content = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        content[i] = i % 256;
      }

      await api.write("/multi-part-file.bin", [content]);

      const stats = await api.stats("/multi-part-file.bin");
      expect(stats?.size).toBe(size);

      // Verify content
      const readContent = await readFile(api, "/multi-part-file.bin");
      expect(readContent.length).toBe(size);
      expect(readContent[0]).toBe(0);
      expect(readContent[size - 1]).toBe((size - 1) % 256);

      await api.remove("/");
    });

    it("should handle streaming chunks for multipart upload", async () => {
      const prefix = `multipart-stream-test-${Date.now()}`;
      const api = new S3FilesApi({
        client: s3Client,
        bucket: bucketName,
        prefix,
      });

      // Create chunks that total more than 5MB
      const chunkSize = 1024 * 1024; // 1MB chunks
      const numChunks = 6; // 6MB total

      async function* generateChunks() {
        for (let i = 0; i < numChunks; i++) {
          const chunk = new Uint8Array(chunkSize);
          chunk.fill(i);
          yield chunk;
        }
      }

      await api.write("/streamed-file.bin", generateChunks());

      const stats = await api.stats("/streamed-file.bin");
      expect(stats?.size).toBe(chunkSize * numChunks);

      // Verify each chunk was written correctly
      const content = await readFile(api, "/streamed-file.bin");
      for (let i = 0; i < numChunks; i++) {
        const offset = i * chunkSize;
        expect(content[offset]).toBe(i);
        expect(content[offset + chunkSize - 1]).toBe(i);
      }

      await api.remove("/");
    });
  });
});
