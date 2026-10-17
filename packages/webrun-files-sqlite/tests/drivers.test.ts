/**
 * SqlarFilesApi over a Durable Object's storage, faked over node:sqlite by
 * @statewalker/db-sqlite-do — including its BLOB shape, which the driver
 * normalises. Proves the adapter on that path, not the runtime.
 */
import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import * as pako from "pako";
import { describe, expect, it } from "vitest";
import { pakoCodec } from "../src/index.js";
import { newArchive } from "./helpers.js";

createFilesApiTests("SqlarFilesApi (Durable Object)", async () => {
  const { db, files } = await newArchive({ driver: "do" });
  return { api: files, cleanup: async () => db.close() };
});

describe("Durable Object", () => {
  it("reads compressed rows and link targets back through the runtime's value shapes", async () => {
    const { db, files } = await newArchive({ driver: "do", codec: pakoCodec(pako) });
    const big = new TextEncoder().encode("line\n".repeat(1000));
    await files.write("/big.txt", [big]);
    await files.symlink("/link", "big.txt");
    await files.copy("/big.txt", "/copy.txt");
    await files.copy("/link", "/link-copy");

    const read = async (p: string) => {
      const chunks: Uint8Array[] = [];
      for await (const c of files.read(p)) chunks.push(c);
      return chunks[0];
    };
    expect(await read("/link")).toEqual(big);
    expect(await read("/copy.txt")).toEqual(big);
    expect(await files.readlink("/link-copy")).toBe("big.txt");
    const [stored] = await db.query<{ t: string; n: number }>(
      "SELECT typeof(data) AS t, length(data) AS n FROM sqlar WHERE name = 'copy.txt'",
    );
    expect(stored.t).toBe("blob");
    expect(stored.n).toBeLessThan(big.byteLength);
  });
});
