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
