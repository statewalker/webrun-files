import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { tryReadJson, writeJsonAtomic } from "./json-io.js";

describe("writeJsonAtomic", () => {
  it("round-trips JSON and creates parent directories", async () => {
    const files = new MemFilesApi();
    await writeJsonAtomic(files, "a/b/c.json", { n: 1 });
    expect(await tryReadJson(files, "a/b/c.json")).toEqual({ n: 1 });
  });

  it("uses a distinct temp path per write so concurrent writers can't clobber it", async () => {
    // A shared `${path}.tmp` lets two concurrent writers (tabs / CLI on the same folder)
    // overwrite each other's temp file and race the rename, corrupting the target. Each
    // write must stage through its own temp path; the final rename is last-writer-wins.
    const files = new MemFilesApi();
    const tmpWrites: string[] = [];
    const origWrite = files.write.bind(files);
    files.write = ((path: string, content: never) => {
      if (path.includes("scanner.json") && path !== "state/scanner.json") tmpWrites.push(path);
      return origWrite(path, content);
    }) as typeof files.write;

    await writeJsonAtomic(files, "state/scanner.json", { writer: 0 });
    await writeJsonAtomic(files, "state/scanner.json", { writer: 1 });

    expect(tmpWrites).toHaveLength(2);
    expect(new Set(tmpWrites).size).toBe(2);
    expect(await tryReadJson(files, "state/scanner.json")).toEqual({ writer: 1 });
  });
});
