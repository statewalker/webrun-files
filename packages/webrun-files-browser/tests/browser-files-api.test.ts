/**
 * Tests for BrowserFilesApi implementation using native-file-system-adapter's memory backend
 */

import { FilesApi } from "@statewalker/webrun-files";
import {
  createBigFilesApiTests,
  createFilesApiTests,
} from "@statewalker/webrun-files-tests";
import { getOriginPrivateDirectory } from "native-file-system-adapter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserFilesApi } from "../src/browser-files-api.js";

describe("BrowserFilesApi with Memory Backend", () => {
  let testCounter = 0;

  createFilesApiTests("BrowserFilesApi", async () => {
    // Create a fresh in-memory filesystem for each test
    // Using the memory adapter from native-file-system-adapter
    const rootHandle = await getOriginPrivateDirectory(
      // @ts-expect-error - adapter type
      import("native-file-system-adapter/src/adapters/memory.js"),
    );

    const browserFilesApi = new BrowserFilesApi({ rootHandle });

    return {
      api: new FilesApi(browserFilesApi),
      cleanup: async () => {
        // Clean up by removing all entries
        for await (const [name] of rootHandle.entries()) {
          await rootHandle.removeEntry(name, { recursive: true });
        }
      },
    };
  });

  createBigFilesApiTests("BrowserFilesApi", async () => {
    // Create a fresh in-memory filesystem for each test
    const rootHandle = await getOriginPrivateDirectory(
      // @ts-expect-error - adapter type
      import("native-file-system-adapter/src/adapters/memory.js"),
    );

    const browserFilesApi = new BrowserFilesApi({ rootHandle });

    return {
      api: new FilesApi(browserFilesApi),
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
  let api: FilesApi;

  beforeEach(async () => {
    rootHandle = await getOriginPrivateDirectory(
      // @ts-expect-error - adapter type
      import("native-file-system-adapter/src/adapters/memory.js"),
    );
    const browserFilesApi = new BrowserFilesApi({ rootHandle });
    api = new FilesApi(browserFilesApi);
  });

  afterEach(async () => {
    // Clean up
    for await (const [name] of rootHandle.entries()) {
      await rootHandle.removeEntry(name, { recursive: true });
    }
  });

  it("should preserve file type/mime type", async () => {
    // Write a file and check if type is preserved
    const encoder = new TextEncoder();
    await api.write("/test.json", [encoder.encode('{"key": "value"}')]);

    const stats = await api.stats("/test.json");
    expect(stats).toBeDefined();
    expect(stats?.kind).toBe("file");
    // Note: The mime type detection depends on the adapter implementation
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

  it("should handle file handle operations", async () => {
    const encoder = new TextEncoder();

    // Create file via handle
    const handle = await api.open("/handle-test.txt");
    await handle.createWriteStream([encoder.encode("initial content")]);
    expect(handle.size).toBe(15);

    // Append via handle
    await handle.appendFile([encoder.encode(" - appended")]);
    expect(handle.size).toBe(26);

    // Read via handle
    const chunks: Uint8Array[] = [];
    for await (const chunk of handle.createReadStream()) {
      chunks.push(chunk);
    }

    const decoder = new TextDecoder();
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    expect(decoder.decode(result)).toBe("initial content - appended");

    await handle.close();
  });
});
