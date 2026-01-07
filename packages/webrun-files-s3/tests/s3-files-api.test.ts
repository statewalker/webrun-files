/**
 * Tests for S3FilesApi implementation using MinIO testcontainer
 */

import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { afterAll, beforeAll, describe } from "vitest";
import { S3FilesApi } from "../src/s3-files-api.js";

describe("S3FilesApi with MinIO", () => {
  let minioContainer: StartedMinioContainer;
  let s3Client: S3Client;
  const bucketName = "test-bucket";
  let testCounter = 0;

  beforeAll(async () => {
    // Start MinIO container
    minioContainer = await new MinioContainer().withExposedPorts(9000).start();

    // Create S3 client configured for MinIO
    s3Client = new S3Client({
      endpoint: minioContainer.getConnectionUrl(),
      region: "us-east-1",
      credentials: {
        accessKeyId: minioContainer.getUsername(),
        secretAccessKey: minioContainer.getPassword(),
      },
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
    // Cleanup
    s3Client?.destroy();
    await minioContainer?.stop();
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
});
