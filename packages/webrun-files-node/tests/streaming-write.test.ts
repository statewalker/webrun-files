/**
 * write() streams: each chunk reaches the disk before the next is pulled, the
 * file appears only once complete (a failing source leaves the old file), and
 * a FilesApi rooted at "/" accepts paths.
 */
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFilesApi } from "../src/index.js";

const dirs: string[] = [];
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "webrun-files-stream-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe("NodeFilesApi.write streams", () => {
  it("puts each chunk on disk before pulling the next", async () => {
    const dir = await tempDir();
    const api = new NodeFilesApi({ rootDir: dir });
    const onDisk: number[] = [];
    const total = () =>
      fsSync
        .readdirSync(path.join(dir, "a"))
        .reduce((n, name) => n + fsSync.statSync(path.join(dir, "a", name)).size, 0);
    async function* chunks() {
      for (let i = 0; i < 4; i++) {
        if (i > 0) onDisk.push(total());
        yield new Uint8Array(64 * 1024).fill(i);
      }
    }
    await api.write("/a/b.bin", chunks());
    expect(onDisk).toEqual([65536, 131072, 196608]);
    expect(fsSync.statSync(path.join(dir, "a/b.bin")).size).toBe(4 * 65536);
    expect(fsSync.readdirSync(path.join(dir, "a"))).toEqual(["b.bin"]);
  });

  it("a failing source leaves the old file and no temporary", async () => {
    const dir = await tempDir();
    const api = new NodeFilesApi({ rootDir: dir });
    await api.write("/f.txt", [new TextEncoder().encode("ORIGINAL")]);
    async function* failing() {
      yield new TextEncoder().encode("A");
      throw new Error("source failed");
    }
    await expect(api.write("/f.txt", failing())).rejects.toThrow("source failed");
    expect(fsSync.readFileSync(path.join(dir, "f.txt"), "utf8")).toBe("ORIGINAL");
    expect(fsSync.readdirSync(dir)).toEqual(["f.txt"]);
  });

  it("can rewrite a file from its own read", async () => {
    const dir = await tempDir();
    const api = new NodeFilesApi({ rootDir: dir });
    await api.write("/f.txt", [new TextEncoder().encode("SELF")]);
    await api.write("/f.txt", api.read("/f.txt"));
    expect(fsSync.readFileSync(path.join(dir, "f.txt"), "utf8")).toBe("SELF");
  });

  it("refuses paths outside the root", async () => {
    const api = new NodeFilesApi({ rootDir: await tempDir() });
    await expect(api.write("/../escape", [new Uint8Array(1)])).rejects.toThrow(/outside rootDir/);
  });
});

describe("NodeFilesApi rooted at /", () => {
  it("accepts absolute paths", async () => {
    const dir = await tempDir();
    const api = new NodeFilesApi({ rootDir: "/" });
    await api.write(`${dir}/x.txt`, [new TextEncoder().encode("x")]);
    expect(await api.exists(`${dir}/x.txt`)).toBe(true);
  });
});
