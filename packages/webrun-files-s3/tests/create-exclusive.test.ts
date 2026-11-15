/**
 * `createExclusive`'s handling of S3's answers to `If-None-Match: *` — 412 when the key
 * exists, 409 while another conditional write is in flight — against a fake client, so
 * it runs without Docker.
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { S3FilesApi } from "../src/index.js";

function s3Error(name: string, httpStatusCode: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
}

/**
 * An empty bucket (HeadObject: 404, ListObjectsV2: nothing) that answers the request
 * creating the object, PutObject or CompleteMultipartUpload, with `answers` in turn.
 */
function fakeClient(answers: (Error | "ok")[]) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command instanceof HeadObjectCommand) throw s3Error("NotFound", 404);
      if (command instanceof ListObjectsV2Command) return { Contents: [] };
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "u1" };
      if (command instanceof UploadPartCommand) return { ETag: '"e"' };
      if (command instanceof AbortMultipartUploadCommand) return {};
      if (
        command instanceof PutObjectCommand ||
        command instanceof CompleteMultipartUploadCommand
      ) {
        const answer = answers.shift() ?? "ok";
        if (answer !== "ok") throw answer;
        return {};
      }
      throw new Error(`unsupported command ${command.constructor.name}`);
    },
  };
  return { client: client as unknown as S3Client, sent };
}

const bytes = (text: string) => [new TextEncoder().encode(text)];
const names = (sent: { name: string }[]) => sent.map((s) => s.name);

describe("S3FilesApi.createExclusive with a fake client", () => {
  it("returns false on 412 Precondition Failed", async () => {
    const { client, sent } = fakeClient([s3Error("PreconditionFailed", 412)]);
    const api = new S3FilesApi({ client, bucket: "b" });
    expect(await api.createExclusive("/x.lock", bytes("x"))).toBe(false);
    const put = sent.find((s) => s.name === "PutObjectCommand");
    expect(put?.input.IfNoneMatch).toBe("*");
  });

  it("recognises a 412 by its status code alone", async () => {
    const { client } = fakeClient([s3Error("UnknownError", 412)]);
    const api = new S3FilesApi({ client, bucket: "b" });
    expect(await api.createExclusive("/x.lock", bytes("x"))).toBe(false);
  });

  it("retries a 409 ConditionalRequestConflict, then succeeds", async () => {
    const { client, sent } = fakeClient([
      s3Error("ConditionalRequestConflict", 409),
      s3Error("ConditionalRequestConflict", 409),
      "ok",
    ]);
    const api = new S3FilesApi({ client, bucket: "b" });
    expect(await api.createExclusive("/x.lock", bytes("x"))).toBe(true);
    expect(names(sent).filter((n) => n === "PutObjectCommand")).toHaveLength(3);
  });

  it("returns false when the retry after a 409 gets 412", async () => {
    const { client } = fakeClient([
      s3Error("ConditionalRequestConflict", 409),
      s3Error("PreconditionFailed", 412),
    ]);
    const api = new S3FilesApi({ client, bucket: "b" });
    expect(await api.createExclusive("/x.lock", bytes("x"))).toBe(false);
  });

  it("gives up after five 409s and throws", async () => {
    const conflict = () => s3Error("ConditionalRequestConflict", 409);
    const { client, sent } = fakeClient(Array.from({ length: 6 }, conflict));
    const api = new S3FilesApi({ client, bucket: "b" });
    await expect(api.createExclusive("/x.lock", bytes("x"))).rejects.toMatchObject({
      name: "ConditionalRequestConflict",
    });
    expect(names(sent).filter((n) => n === "PutObjectCommand")).toHaveLength(5);
  });

  it("does not treat a 412 as false for a plain write", async () => {
    const { client } = fakeClient([s3Error("PreconditionFailed", 412)]);
    const api = new S3FilesApi({ client, bucket: "b" });
    await expect(api.write("/x", bytes("x"))).rejects.toMatchObject({ name: "PreconditionFailed" });
  });

  it("returns false on 412 from CompleteMultipartUpload, and aborts the upload", async () => {
    const { client, sent } = fakeClient([s3Error("PreconditionFailed", 412)]);
    const api = new S3FilesApi({ client, bucket: "b", multipartPartSize: 4 });
    const result = await api.createExclusive("/big.lock", [
      new Uint8Array(4),
      new Uint8Array(4),
      new Uint8Array(2),
    ]);
    expect(result).toBe(false);
    const complete = sent.find((s) => s.name === "CompleteMultipartUploadCommand");
    expect(complete?.input.IfNoneMatch).toBe("*");
    expect(names(sent)).toContain("AbortMultipartUploadCommand");
  });

  it("returns false without uploading when the path exists", async () => {
    const { client, sent } = fakeClient([]);
    const exists = {
      send: async (command: unknown) => {
        if (command instanceof HeadObjectCommand) return { ContentLength: 1 };
        return client.send(command as never);
      },
    } as unknown as S3Client;
    const api = new S3FilesApi({ client: exists, bucket: "b" });
    expect(await api.createExclusive("/x.lock", bytes("x"))).toBe(false);
    expect(names(sent)).not.toContain("PutObjectCommand");
  });
});
