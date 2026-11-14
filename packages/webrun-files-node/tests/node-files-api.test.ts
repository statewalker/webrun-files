import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { describe, expect, it } from "vitest";
import { NodeFilesApi } from "../src/index.js";

let testDir: string;

createFilesApiTests("NodeFilesApi", async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "webrun-files-test-"));
  return {
    api: new NodeFilesApi({ rootDir: testDir }),
    cleanup: async () => {
      await fs.rm(testDir, { recursive: true, force: true });
    },
  };
});

describe("NodeFilesApi keeps every path inside rootDir", () => {
  const bytes = (s: string) => [new TextEncoder().encode(s)];

  it("refuses paths whose .. segments leave rootDir", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "webrun-files-confine-"));
    const rootDir = path.join(parent, "root");
    await fs.mkdir(rootDir);
    const api = new NodeFilesApi({ rootDir });
    try {
      await expect(api.write("/../outside.txt", bytes("x"))).rejects.toThrow(/outside rootDir/);
      await expect(api.write("/a/../../outside.txt", bytes("x"))).rejects.toThrow(
        /outside rootDir/,
      );
      await expect(api.mkdir("/../outside-dir")).rejects.toThrow(/outside rootDir/);
      await expect(api.stats("/..")).rejects.toThrow(/outside rootDir/);
      const reading = async () => {
        for await (const _ of api.read("/../root/../outside.txt")) {
          // drain
        }
      };
      await expect(reading()).rejects.toThrow(/outside rootDir/);
      // Nothing was created next to rootDir.
      expect((await fs.readdir(parent)).sort()).toEqual(["root"]);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("allows .. segments that stay inside rootDir", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "webrun-files-confine-"));
    const api = new NodeFilesApi({ rootDir });
    try {
      await api.write("/a/../b.txt", bytes("inside"));
      expect(await fs.readFile(path.join(rootDir, "b.txt"), "utf8")).toBe("inside");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe("NodeFilesApi.createExclusive", () => {
  const bytes = (s: string) => [new TextEncoder().encode(s)];

  it("treats a symbolic link as existing, even a dangling one", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "webrun-files-excl-"));
    const api = new NodeFilesApi({ rootDir });
    try {
      await fs.writeFile(path.join(rootDir, "target.txt"), "target");
      await fs.symlink("target.txt", path.join(rootDir, "link.txt"));
      await fs.symlink("missing.txt", path.join(rootDir, "dangling.txt"));
      expect(await api.createExclusive("/link.txt", bytes("x"))).toBe(false);
      expect(await api.createExclusive("/dangling.txt", bytes("x"))).toBe(false);
      expect(await fs.readFile(path.join(rootDir, "target.txt"), "utf8")).toBe("target");
      await expect(fs.access(path.join(rootDir, "missing.txt"))).rejects.toThrow();
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("refuses paths outside rootDir and reports the root as existing", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "webrun-files-excl-"));
    const rootDir = path.join(parent, "root");
    await fs.mkdir(rootDir);
    const api = new NodeFilesApi({ rootDir });
    try {
      await expect(api.createExclusive("/../outside.lock", bytes("x"))).rejects.toThrow(
        /outside rootDir/,
      );
      await expect(fs.access(path.join(parent, "outside.lock"))).rejects.toThrow();
      expect(await api.createExclusive("/", bytes("x"))).toBe(false);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("excludes a second NodeFilesApi over the same directory", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "webrun-files-excl-"));
    const a = new NodeFilesApi({ rootDir });
    const b = new NodeFilesApi({ rootDir });
    try {
      const results = await Promise.all([
        a.createExclusive("/index.lock", bytes("a")),
        b.createExclusive("/index.lock", bytes("b")),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe("NodeFilesApi.move onto an existing entry (rename(2), the reference for MemFilesApi)", () => {
  const bytes = (s: string) => [new TextEncoder().encode(s)];

  async function populated() {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "webrun-files-move-"));
    const api = new NodeFilesApi({ rootDir });
    await api.write("/file.txt", bytes("file"));
    await api.write("/dir/a.txt", bytes("a"));
    await api.write("/dir/sub/b.txt", bytes("b"));
    await api.mkdir("/empty");
    await api.write("/full/x.txt", bytes("x"));
    return { api, rootDir };
  }

  it("replaces an empty directory with a directory", async () => {
    const { api, rootDir } = await populated();
    try {
      expect(await api.move("/dir", "/empty")).toBe(true);
      expect(await fs.readFile(path.join(rootDir, "empty/sub/b.txt"), "utf8")).toBe("b");
      expect(await api.exists("/dir")).toBe(false);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  for (const [what, source, target] of [
    ["a directory onto a non-empty directory", "/dir", "/full"],
    ["a file onto a directory", "/file.txt", "/empty"],
    ["a directory onto a file", "/dir", "/file.txt"],
    ["a directory into itself", "/dir", "/dir/sub/inner"],
    ["a directory onto its own parent", "/dir/sub", "/dir"],
    ["a file below a file", "/dir/a.txt", "/file.txt/a.txt"],
  ] as const) {
    it(`refuses ${what}: returns false and changes nothing`, async () => {
      const { api, rootDir } = await populated();
      try {
        expect(await api.move(source, target)).toBe(false);
        expect(await fs.readFile(path.join(rootDir, "file.txt"), "utf8")).toBe("file");
        expect(await fs.readFile(path.join(rootDir, "dir/sub/b.txt"), "utf8")).toBe("b");
        expect(await fs.readFile(path.join(rootDir, "full/x.txt"), "utf8")).toBe("x");
        expect(await fs.readdir(path.join(rootDir, "empty"))).toEqual([]);
      } finally {
        await fs.rm(rootDir, { recursive: true, force: true });
      }
    });
  }
});
