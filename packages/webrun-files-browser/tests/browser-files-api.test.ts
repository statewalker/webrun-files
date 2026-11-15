/**
 * Tests for BrowserFilesApi implementation using native-file-system-adapter's memory backend
 */

import { MoveIncompleteError } from "@statewalker/webrun-files";
import {
  collectGenerator,
  collectStream,
  createFilesApiTests,
} from "@statewalker/webrun-files-tests";
import { getOriginPrivateDirectory } from "native-file-system-adapter";
// @ts-expect-error - no type declarations for this module
import * as driver from "native-file-system-adapter/src/adapters/memory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    rootHandle = (await getOriginPrivateDirectory(
      // @ts-expect-error - adapter type
      import("native-file-system-adapter/src/adapters/memory.js"),
    )) as FileSystemDirectoryHandle;
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
    expect(stats?.kind === "file" && stats.size).toBe(16);
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

describe("BrowserFilesApi.write when the commit fails", () => {
  it("leaves no empty file behind when close() rejects", async () => {
    const rootHandle = (await getOriginPrivateDirectory(driver)) as FileSystemDirectoryHandle;
    const api = new BrowserFilesApi({ rootHandle });
    const getFileHandle = rootHandle.getFileHandle.bind(rootHandle);
    rootHandle.getFileHandle = (async (name: string, options?: FileSystemGetFileOptions) => {
      const handle = await getFileHandle(name, options);
      if (!options?.create) return handle;
      const createWritable = handle.createWritable.bind(handle);
      handle.createWritable = (async () => {
        const writable = await createWritable();
        writable.close = async () => {
          await writable.abort();
          throw new Error("quota exceeded");
        };
        return writable;
      }) as typeof handle.createWritable;
      return handle;
    }) as typeof rootHandle.getFileHandle;
    await expect(api.write("/q.txt", [new TextEncoder().encode("data")])).rejects.toThrow(
      "quota exceeded",
    );
    rootHandle.getFileHandle = getFileHandle;
    expect(await api.exists("/q.txt")).toBe(false);
  });
});

describe("BrowserFilesApi.createExclusive across tabs", () => {
  const bytes = (s: string) => [new TextEncoder().encode(s)];

  /** Chunks arriving after macrotasks, so unserialized calls would interleave. */
  async function* slowly(text: string) {
    for (const part of [text, ` ${text}`]) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      yield new TextEncoder().encode(part);
    }
  }

  /** A `navigator.locks` that runs the callbacks of one name one at a time, as browsers do. */
  function fakeLocks() {
    const requests: { name: string; mode: string | undefined; ifAvailable?: boolean }[] = [];
    const tails = new Map<string, Promise<unknown>>();
    // Requests per name that hold the lock or wait for it.
    const pending = new Map<string, number>();
    let running = 0;
    let maxRunning = 0;
    const locks = {
      request(
        name: string,
        options: { mode?: string; ifAvailable?: boolean },
        callback: (lock: object | null) => Promise<unknown>,
      ) {
        requests.push({ name, mode: options.mode, ifAvailable: options.ifAvailable });
        // `ifAvailable`: granted only if nobody holds or waits for the lock, else null.
        if (options.ifAvailable && (pending.get(name) ?? 0) > 0) {
          return Promise.resolve().then(() => callback(null));
        }
        pending.set(name, (pending.get(name) ?? 0) + 1);
        const run = (tails.get(name) ?? Promise.resolve()).then(async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          try {
            return await callback({ name });
          } finally {
            running--;
            pending.set(name, (pending.get(name) ?? 1) - 1);
          }
        });
        tails.set(
          name,
          run.catch(() => {}),
        );
        return run;
      },
    };
    return { locks, requests, maxRunning: () => maxRunning };
  }

  async function newRoot() {
    return (await getOriginPrivateDirectory(driver)) as FileSystemDirectoryHandle;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("takes an exclusive Web Lock per directory and path", async () => {
    const fake = fakeLocks();
    vi.stubGlobal("navigator", { locks: fake.locks });
    const rootHandle = await newRoot();
    const api = new BrowserFilesApi({ rootHandle });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => api.createExclusive("/a/index.lock", slowly(`w${i}`))),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(fake.requests).toHaveLength(10);
    expect(fake.maxRunning()).toBe(1);
    const names = new Set(fake.requests.map((r) => r.name));
    expect(names.size).toBe(1);
    expect([...names][0]).toMatch(/^webrun-files:handle:.+:\/a\/index\.lock$/);
    expect(fake.requests.every((r) => r.mode === "exclusive")).toBe(true);
  });

  it("lets instances with one lockScope exclude each other, as tabs would", async () => {
    const fake = fakeLocks();
    vi.stubGlobal("navigator", { locks: fake.locks });
    const rootHandle = await newRoot();
    // Two "tabs": separate instances over the same directory.
    const tabA = new BrowserFilesApi({ rootHandle, lockScope: "repo" });
    const tabB = new BrowserFilesApi({ rootHandle, lockScope: "repo" });

    const results = await Promise.all([
      tabA.createExclusive("/HEAD.lock", slowly("a")),
      tabB.createExclusive("/HEAD.lock", slowly("b")),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(fake.requests.map((r) => r.name)).toEqual([
      "webrun-files:repo:/HEAD.lock",
      "webrun-files:repo:/HEAD.lock",
    ]);
  });

  it("names a directory in the Origin Private File System by its path there", async () => {
    const fake = fakeLocks();
    const rootHandle = await newRoot();
    vi.stubGlobal("navigator", {
      locks: fake.locks,
      storage: { getDirectory: async () => ({ resolve: async () => ["repos", "one"] }) },
    });
    const api = new BrowserFilesApi({ rootHandle });
    expect(await api.createExclusive("/x.lock", bytes("x"))).toBe(true);
    expect(fake.requests[0]?.name).toBe("webrun-files:opfs:/repos/one/x.lock");
  });

  it("serializes calls in memory without navigator.locks", async () => {
    vi.stubGlobal("navigator", {});
    const rootHandle = await newRoot();
    const api = new BrowserFilesApi({ rootHandle });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => api.createExclusive("/index.lock", slowly(`w${i}`))),
    );
    const winner = results.indexOf(true);
    expect(results.filter(Boolean)).toHaveLength(1);
    const content = await collectStream(api.read("/index.lock"));
    expect(new TextDecoder().decode(content)).toBe(`w${winner} w${winner}`);
    // The mutex is released after each call: later calls proceed.
    expect(await api.createExclusive("/index.lock", bytes("again"))).toBe(false);
    expect(await api.createExclusive("/other.lock", bytes("other"))).toBe(true);
  });
  it("names an OPFS lock by the file's full OPFS path, whatever the instance's root", async () => {
    const fake = fakeLocks();
    const opfsRoot = await newRoot();
    const repo = await opfsRoot.getDirectoryHandle("repo", { create: true });
    const paths = new Map<FileSystemDirectoryHandle, string[]>([
      [opfsRoot, []],
      [repo, ["repo"]],
    ]);
    vi.stubGlobal("navigator", {
      locks: fake.locks,
      storage: {
        getDirectory: async () => ({
          resolve: async (h: FileSystemDirectoryHandle) => paths.get(h) ?? null,
        }),
      },
    });
    // One instance rooted at OPFS `/repo`, one at OPFS `/`: the same file.
    const inRepo = new BrowserFilesApi({ rootHandle: repo });
    const atRoot = new BrowserFilesApi({ rootHandle: opfsRoot, lockScope: "ignored-in-opfs" });

    const results = await Promise.all([
      inRepo.createExclusive("/HEAD.lock", slowly("a")),
      atRoot.createExclusive("/repo/HEAD.lock", slowly("b")),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(fake.requests.map((r) => r.name)).toEqual([
      "webrun-files:opfs:/repo/HEAD.lock",
      "webrun-files:opfs:/repo/HEAD.lock",
    ]);
  });

  describe("does not wait for a winner whose source stalls", () => {
    function stalled() {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      async function* source() {
        yield new TextEncoder().encode("first");
        await gate;
        yield new TextEncoder().encode(" last");
      }
      return { source: source(), release };
    }

    async function loserReturnsAtOnce(api: BrowserFilesApi) {
      // The memory adapter's roots share one tree: a path of its own for each run.
      const path = `/stalled-${crypto.randomUUID()}.lock`;
      const { source, release } = stalled();
      const winner = api.createExclusive(path, source);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const loser = await Promise.race([
        api.createExclusive(path, bytes("other")),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 200)),
      ]);
      release();
      expect(loser).toBe(false);
      expect(await winner).toBe(true);
      expect(new TextDecoder().decode(await collectStream(api.read(path)))).toBe("first last");
    }

    it("with Web Locks, asking ifAvailable", async () => {
      const fake = fakeLocks();
      vi.stubGlobal("navigator", { locks: fake.locks });
      await loserReturnsAtOnce(new BrowserFilesApi({ rootHandle: await newRoot() }));
      expect(fake.requests.every((r) => r.ifAvailable === true)).toBe(true);
    });

    it("with the in-memory mutex", async () => {
      vi.stubGlobal("navigator", {});
      await loserReturnsAtOnce(new BrowserFilesApi({ rootHandle: await newRoot() }));
    });
  });
});

describe("BrowserFilesApi.move", () => {
  const bytes = (s: string) => [new TextEncoder().encode(s)];
  /** A fresh API; the memory adapter's root outlives a test, so it is emptied first. */
  async function setup() {
    const rootHandle = (await getOriginPrivateDirectory(driver)) as FileSystemDirectoryHandle;
    for await (const [name] of rootHandle.entries()) {
      await rootHandle.removeEntry(name, { recursive: true });
    }
    return { rootHandle, api: new BrowserFilesApi({ rootHandle }) };
  }
  async function text(api: BrowserFilesApi, path: string) {
    return new TextDecoder().decode(await collectStream(api.read(path)));
  }

  describe("copy-then-delete fallback when the source cannot be deleted", () => {
    it("retries once, then throws MoveIncompleteError; the target holds the new content", async () => {
      const { rootHandle, api } = await setup();
      await api.write("/index.lock", bytes("new index"));
      await api.write("/index", bytes("old index"));
      const removeEntry = vi
        .spyOn(rootHandle, "removeEntry")
        .mockRejectedValue(new DOMException("locked", "NoModificationAllowedError"));

      const moving = api.move("/index.lock", "/index");
      await expect(moving).rejects.toBeInstanceOf(MoveIncompleteError);
      await expect(moving).rejects.toThrow(
        "move /index.lock -> /index: the target was replaced, but the source could not be removed",
      );
      expect(removeEntry).toHaveBeenCalledTimes(2);
      removeEntry.mockRestore();

      expect(await text(api, "/index")).toBe("new index");
      expect(await text(api, "/index.lock")).toBe("new index");
    });

    it("succeeds when the retry removes the source", async () => {
      const { rootHandle, api } = await setup();
      await api.write("/a.lock", bytes("new"));
      await api.write("/a", bytes("old"));
      const removeEntry = vi
        .spyOn(rootHandle, "removeEntry")
        .mockRejectedValueOnce(new DOMException("busy", "NoModificationAllowedError"));

      expect(await api.move("/a.lock", "/a")).toBe(true);
      expect(removeEntry).toHaveBeenCalledTimes(2);
      removeEntry.mockRestore();
      expect(await text(api, "/a")).toBe("new");
      expect(await api.exists("/a.lock")).toBe(false);
    });
  });

  it("falls back and replaces the target when the native move() refuses an existing file", async () => {
    const { rootHandle, api } = await setup();
    await api.write("/ref.lock", bytes("new ref"));
    await api.write("/ref", bytes("old ref"));
    const getFileHandle = rootHandle.getFileHandle.bind(rootHandle);
    const nativeMove = vi.fn(async () => {
      throw new DOMException("target exists", "InvalidModificationError");
    });
    rootHandle.getFileHandle = (async (name: string, options?: FileSystemGetFileOptions) =>
      Object.assign(await getFileHandle(name, options), {
        move: nativeMove,
      })) as typeof rootHandle.getFileHandle;

    expect(await api.move("/ref.lock", "/ref")).toBe(true);
    rootHandle.getFileHandle = getFileHandle;
    expect(nativeMove).toHaveBeenCalledTimes(1);
    expect(await text(api, "/ref")).toBe("new ref");
    expect(await api.exists("/ref.lock")).toBe(false);
  });

  it("uses the native move() when it succeeds, without copying", async () => {
    const { rootHandle, api } = await setup();
    await api.write("/x.lock", bytes("new"));
    await api.write("/x", bytes("old"));
    const getFileHandle = rootHandle.getFileHandle.bind(rootHandle);
    // Stands in for Chromium's OPFS move(): replaces the target in one step.
    const nativeMove = vi.fn(async (parent: FileSystemDirectoryHandle, name: string) => {
      const file = await (await getFileHandle("x.lock")).getFile();
      const writable = await (await parent.getFileHandle(name, { create: true })).createWritable();
      await writable.write(await file.arrayBuffer());
      await writable.close();
      await rootHandle.removeEntry("x.lock");
    });
    rootHandle.getFileHandle = (async (name: string, options?: FileSystemGetFileOptions) =>
      Object.assign(await getFileHandle(name, options), {
        move: nativeMove,
      })) as typeof rootHandle.getFileHandle;

    expect(await api.move("/x.lock", "/x")).toBe(true);
    rootHandle.getFileHandle = getFileHandle;
    expect(nativeMove).toHaveBeenCalledTimes(1);
    expect(await text(api, "/x")).toBe("new");
    expect(await api.exists("/x.lock")).toBe(false);
  });

  describe("onto an existing entry, as rename(2) does", () => {
    async function populated() {
      const { api } = await setup();
      await api.write("/file.txt", bytes("file"));
      await api.write("/dir/a.txt", bytes("a"));
      await api.write("/dir/sub/b.txt", bytes("b"));
      await api.mkdir("/empty");
      await api.write("/full/x.txt", bytes("x"));
      return api;
    }
    const paths = async (api: BrowserFilesApi) =>
      (await collectGenerator(api.list("/", { recursive: true }))).map((e) => e.path);

    it("replaces an empty directory with a directory", async () => {
      const api = await populated();
      expect(await api.move("/dir", "/empty")).toBe(true);
      expect(await text(api, "/empty/sub/b.txt")).toBe("b");
      expect(await api.exists("/dir")).toBe(false);
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
        const api = await populated();
        const before = await paths(api);
        expect(await api.move(source, target)).toBe(false);
        expect(await paths(api)).toEqual(before);
        expect(await text(api, "/file.txt")).toBe("file");
        expect(await text(api, "/dir/sub/b.txt")).toBe("b");
      });
    }
  });
});

describe("BrowserFilesApi.move: which native move() errors fall back", () => {
  const bytes = (s: string) => [new TextEncoder().encode(s)];
  async function setup() {
    const rootHandle = (await getOriginPrivateDirectory(driver)) as FileSystemDirectoryHandle;
    for await (const [name] of rootHandle.entries()) {
      await rootHandle.removeEntry(name, { recursive: true });
    }
    return { rootHandle, api: new BrowserFilesApi({ rootHandle }) };
  }
  async function text(api: BrowserFilesApi, path: string) {
    return new TextDecoder().decode(await collectStream(api.read(path)));
  }
  /** Gives every file handle of the root a native move() doing `impl`. */
  function fakeNativeMove(
    rootHandle: FileSystemDirectoryHandle,
    impl: (parent: FileSystemDirectoryHandle, name: string) => Promise<void>,
  ) {
    const getFileHandle = rootHandle.getFileHandle.bind(rootHandle);
    const nativeMove = vi.fn(impl);
    rootHandle.getFileHandle = (async (name: string, options?: FileSystemGetFileOptions) =>
      Object.assign(await getFileHandle(name, options), {
        move: nativeMove,
      })) as typeof rootHandle.getFileHandle;
    return { nativeMove, restore: () => (rootHandle.getFileHandle = getFileHandle) };
  }

  for (const [what, error] of [
    ["a TypeError (move() unsupported for this handle)", new TypeError("not a function")],
    ["a NotSupportedError", new DOMException("unsupported", "NotSupportedError")],
  ] as const) {
    it(`falls back to copy-then-delete on ${what}`, async () => {
      const { rootHandle, api } = await setup();
      await api.write("/src.txt", bytes("payload"));
      const { nativeMove, restore } = fakeNativeMove(rootHandle, async () => {
        throw error;
      });
      expect(await api.move("/src.txt", "/dst.txt")).toBe(true);
      restore();
      expect(nativeMove).toHaveBeenCalledTimes(1);
      expect(await text(api, "/dst.txt")).toBe("payload");
      expect(await api.exists("/src.txt")).toBe(false);
    });
  }

  for (const [what, error] of [
    ["NoModificationAllowedError", new DOMException("locked", "NoModificationAllowedError")],
    ["NotAllowedError", new DOMException("denied", "NotAllowedError")],
    ["a plain Error", new Error("disk full")],
    [
      "InvalidModificationError when the target does not exist",
      new DOMException("bad", "InvalidModificationError"),
    ],
  ] as const) {
    it(`rethrows ${what}, changing nothing`, async () => {
      const { rootHandle, api } = await setup();
      await api.write("/src.txt", bytes("payload"));
      const { restore } = fakeNativeMove(rootHandle, async () => {
        throw error;
      });
      await expect(api.move("/src.txt", "/dst.txt")).rejects.toBe(error);
      restore();
      expect(await text(api, "/src.txt")).toBe("payload");
      expect(await api.exists("/dst.txt")).toBe(false);
    });
  }

  it("treats the move as done when move() throws after the source has moved", async () => {
    const { rootHandle, api } = await setup();
    await api.write("/src.txt", bytes("payload"));
    const getFileHandle = rootHandle.getFileHandle.bind(rootHandle);
    const { nativeMove, restore } = fakeNativeMove(rootHandle, async (parent, name) => {
      const file = await (await getFileHandle("src.txt")).getFile();
      const writable = await (await parent.getFileHandle(name, { create: true })).createWritable();
      await writable.write(await file.arrayBuffer());
      await writable.close();
      await rootHandle.removeEntry("src.txt");
      throw new DOMException("late failure", "UnknownError");
    });
    expect(await api.move("/src.txt", "/dst.txt")).toBe(true);
    restore();
    expect(nativeMove).toHaveBeenCalledTimes(1);
    expect(await text(api, "/dst.txt")).toBe("payload");
    expect(await api.exists("/src.txt")).toBe(false);
  });
});
