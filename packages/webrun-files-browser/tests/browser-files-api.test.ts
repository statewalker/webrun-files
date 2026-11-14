/**
 * Tests for BrowserFilesApi implementation using native-file-system-adapter's memory backend
 */

import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { getOriginPrivateDirectory } from "native-file-system-adapter";
// @ts-expect-error - no type declarations for this module
import * as driver from "native-file-system-adapter/src/adapters/memory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserFilesApi } from "../src/browser-files-api.js";

describe("BrowserFilesApi with Memory Backend", () => {
  createFilesApiTests("BrowserFilesApi", async () => {
    // Create a fresh in-memory filesystem for each test
    // Using the memory adapter from native-file-system-adapter

    const rootHandle = (await getOriginPrivateDirectory(driver)) as FileSystemDirectoryHandle;

    return {
      api: new BrowserFilesApi({ rootHandle }),
      cleanup: async () => {
        // Clean up by removing all entries
        for await (const [name] of rootHandle.entries()) {
          await rootHandle.removeEntry(name, { recursive: true });
        }
      },
    };
  });
});

/**
 * Additional tests specific to BrowserFilesApi
 */
describe("BrowserFilesApi specific tests", () => {
  let rootHandle: FileSystemDirectoryHandle;
  let api: BrowserFilesApi;

  beforeEach(async () => {
    rootHandle = await getOriginPrivateDirectory(
      // @ts-expect-error - adapter type
      import("native-file-system-adapter/src/adapters/memory.js"),
    );
    api = new BrowserFilesApi({ rootHandle });
  });

  afterEach(async () => {
    // Clean up
    for await (const [name] of rootHandle.entries()) {
      await rootHandle.removeEntry(name, { recursive: true });
    }
  });

  it("should preserve file metadata", async () => {
    // Write a file and check if stats work
    const encoder = new TextEncoder();
    await api.write("/test.json", [encoder.encode('{"key": "value"}')]);

    const stats = await api.stats("/test.json");
    expect(stats).toBeDefined();
    expect(stats?.kind).toBe("file");
    expect(stats?.size).toBe(16);
  });

  it("should handle empty directory listing", async () => {
    await api.mkdir("/empty-dir");

    const entries: unknown[] = [];
    for await (const entry of api.list("/empty-dir")) {
      entries.push(entry);
    }

    expect(entries.length).toBe(0);
  });

  it("should handle nested directory creation", async () => {
    await api.mkdir("/a/b/c/d/e");

    expect(await api.exists("/a")).toBe(true);
    expect(await api.exists("/a/b")).toBe(true);
    expect(await api.exists("/a/b/c")).toBe(true);
    expect(await api.exists("/a/b/c/d")).toBe(true);
    expect(await api.exists("/a/b/c/d/e")).toBe(true);
  });
});

describe("BrowserFilesApi.write when the content fails part way", () => {
  async function freshApi() {
    const rootHandle = (await getOriginPrivateDirectory(driver)) as FileSystemDirectoryHandle;
    return new BrowserFilesApi({ rootHandle });
  }
  async function* failing() {
    yield new TextEncoder().encode("partial");
    throw new Error("source failed");
  }
  async function text(api: BrowserFilesApi, path: string) {
    const parts: Uint8Array[] = [];
    for await (const c of api.read(path)) parts.push(c);
    return new TextDecoder().decode(Buffer.concat(parts));
  }

  it("keeps the old file", async () => {
    const api = await freshApi();
    await api.write("/f.txt", [new TextEncoder().encode("old content")]);
    await expect(api.write("/f.txt", failing())).rejects.toThrow("source failed");
    expect(await text(api, "/f.txt")).toBe("old content");
  });

  it("leaves no file behind when there was none", async () => {
    const api = await freshApi();
    await expect(api.write("/new.txt", failing())).rejects.toThrow("source failed");
    expect(await api.exists("/new.txt")).toBe(false);
  });
});
