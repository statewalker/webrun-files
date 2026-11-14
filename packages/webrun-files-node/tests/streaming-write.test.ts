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

describe("NodeFilesApi.write keeps what an in-place write kept", () => {
  it("keeps the mode of the file it replaces", async () => {
    const dir = await tempDir();
    const api = new NodeFilesApi({ rootDir: dir });
    await api.write("/run.sh", [new TextEncoder().encode("#!/bin/sh\n")]);
    fsSync.chmodSync(path.join(dir, "run.sh"), 0o755);
    await api.write("/run.sh", [new TextEncoder().encode("#!/bin/sh\necho hi\n")]);
    expect(fsSync.statSync(path.join(dir, "run.sh")).mode & 0o777).toBe(0o755);
  });

  it("writes through a symbolic link to the file it points to", async () => {
    const dir = await tempDir();
    const api = new NodeFilesApi({ rootDir: dir });
    await api.write("/real.txt", [new TextEncoder().encode("old")]);
    fsSync.symlinkSync("real.txt", path.join(dir, "link.txt"));
    await api.write("/link.txt", [new TextEncoder().encode("new")]);
    expect(fsSync.lstatSync(path.join(dir, "link.txt")).isSymbolicLink()).toBe(true);
    expect(fsSync.readFileSync(path.join(dir, "real.txt"), "utf8")).toBe("new");
  });

  it("writes names up to the file system limit (the temporary name is short)", async () => {
    const dir = await tempDir();
    const api = new NodeFilesApi({ rootDir: dir });
    const name = `/${"n".repeat(240)}.txt`;
    await api.write(name, [new TextEncoder().encode("x")]);
    expect(await api.exists(name)).toBe(true);
  });

  it("refuses to write the root itself, touching nothing outside it", async () => {
    const parent = await tempDir();
    const root = path.join(parent, "root");
    fsSync.mkdirSync(root);
    const api = new NodeFilesApi({ rootDir: root });
    await expect(api.write("/", [new Uint8Array(1)])).rejects.toThrow();
    expect(fsSync.readdirSync(parent)).toEqual(["root"]);
  });

  it("does not list a write in flight", async () => {
    const dir = await tempDir();
    const api = new NodeFilesApi({ rootDir: dir });
    let listed: string[] = [];
    async function* chunks() {
      yield new Uint8Array(70_000);
      for await (const info of api.list("/")) listed.push(info.name);
      yield new Uint8Array(10);
    }
    await api.write("/f.bin", chunks());
    expect(listed).toEqual([]);
    listed = [];
    for await (const info of api.list("/")) listed.push(info.name);
    expect(listed).toEqual(["f.bin"]);
  });
});

describe("NodeFilesApi.write: what a replacing write must not change", () => {
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it.skipIf(asRoot)("refuses to overwrite a read-only file, as an in-place write did", async () => {
    const dir = await tempDir();
    const api = new NodeFilesApi({ rootDir: dir });
    await api.write("/ro.txt", [new TextEncoder().encode("keep")]);
    fsSync.chmodSync(path.join(dir, "ro.txt"), 0o444);
    await expect(api.write("/ro.txt", [new TextEncoder().encode("x")])).rejects.toThrow();
    expect(fsSync.readFileSync(path.join(dir, "ro.txt"), "utf8")).toBe("keep");
  });

  it("drops setuid and setgid bits from rewritten content", async () => {
    const dir = await tempDir();
    const api = new NodeFilesApi({ rootDir: dir });
    await api.write("/tool", [new TextEncoder().encode("a")]);
    fsSync.chmodSync(path.join(dir, "tool"), 0o6755);
    await api.write("/tool", [new TextEncoder().encode("b")]);
    expect(fsSync.statSync(path.join(dir, "tool")).mode & 0o7777).toBe(0o755);
  });

  it("lists user entries whose names only start like a temporary", async () => {
    const dir = await tempDir();
    const api = new NodeFilesApi({ rootDir: dir });
    await api.write("/.webrun-tmp-notes", [new TextEncoder().encode("mine")]);
    const names: string[] = [];
    for await (const info of api.list("/")) names.push(info.name);
    expect(names).toEqual([".webrun-tmp-notes"]);
  });

  it("refuses a directory target before pulling the content", async () => {
    const dir = await tempDir();
    const api = new NodeFilesApi({ rootDir: dir });
    fsSync.mkdirSync(path.join(dir, "sub"));
    let pulled = 0;
    async function* chunks() {
      for (let i = 0; i < 5; i++) {
        pulled++;
        yield new Uint8Array(10);
      }
    }
    await expect(api.write("/sub", chunks())).rejects.toThrow();
    expect(pulled).toBe(0);
  });
});
