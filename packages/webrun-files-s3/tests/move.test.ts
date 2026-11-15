/**
 * `move` is a copy, then a delete (S3 has no rename). What a failing delete leaves,
 * against a fake client, so it runs without Docker.
 */
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { MoveIncompleteError } from "@statewalker/webrun-files";
import { describe, expect, it } from "vitest";
import { S3FilesApi } from "../src/index.js";

/** A bucket holding the file "x.lock"; DeleteObject fails `failures` times with a 500. */
function fakeClient(failures: number) {
  const sent: string[] = [];
  let deleted = false;
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      sent.push(command.constructor.name);
      if (command instanceof HeadObjectCommand) {
        if (command.input.Key === "x.lock" && !deleted) return { ContentLength: 3 };
        throw Object.assign(new Error("NotFound"), { $metadata: { httpStatusCode: 404 } });
      }
      if (command instanceof CopyObjectCommand) return {};
      if (command instanceof DeleteObjectCommand) {
        if (failures-- > 0) {
          throw Object.assign(new Error("InternalError"), { $metadata: { httpStatusCode: 500 } });
        }
        deleted = true;
        return {};
      }
      throw new Error(`unsupported command ${command.constructor.name}`);
    },
  };
  return { client: client as unknown as S3Client, sent };
}

describe("S3FilesApi.move when the source cannot be deleted", () => {
  it("retries once, then throws MoveIncompleteError instead of returning false", async () => {
    const { client, sent } = fakeClient(2);
    const api = new S3FilesApi({ client, bucket: "b" });
    const moving = api.move("/x.lock", "/x");
    await expect(moving).rejects.toBeInstanceOf(MoveIncompleteError);
    await expect(moving).rejects.toThrow(
      "move /x.lock -> /x: the target was replaced, but the source could not be removed",
    );
    expect(sent.filter((name) => name === "CopyObjectCommand")).toHaveLength(1);
    expect(sent.filter((name) => name === "DeleteObjectCommand")).toHaveLength(2);
  });

  it("succeeds when the retry deletes the source", async () => {
    const { client, sent } = fakeClient(1);
    const api = new S3FilesApi({ client, bucket: "b" });
    expect(await api.move("/x.lock", "/x")).toBe(true);
    expect(sent.filter((name) => name === "DeleteObjectCommand")).toHaveLength(2);
  });
});
