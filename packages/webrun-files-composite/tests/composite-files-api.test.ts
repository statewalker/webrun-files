import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { beforeEach, describe, expect, it } from "vitest";
import { CompositeFilesApi } from "../src/index.js";

// --- Shared test suite: single mount (composite wrapping one MemFilesApi) ---

createFilesApiTests("CompositeFilesApi (single mount)", async () => ({
  api: new CompositeFilesApi(new MemFilesApi()),
}));

// --- Shared test suite: multi-mount ---

createFilesApiTests("CompositeFilesApi (multi mount)", async () => {
  const root = new MemFilesApi();
  const sub = new MemFilesApi();
  const composite = new CompositeFilesApi(root);
  composite.mount("/mounted", sub);
  return { api: composite };
});

// --- Custom tests for composite-specific behavior ---

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBytes(text: string): Uint8Array {
  return encoder.encode(text);
}

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  if (chunks.length === 0) return "";
  const total = chunks.reduce((a, b) => a + b.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return decoder.decode(result);
}

async function collectEntries(
  stream: AsyncIterable<{ name: string; path: string; kind: string }>,
): Promise<Array<{ name: string; path: string; kind: string }>> {
  const result: Array<{ name: string; path: string; kind: string }> = [];
  for await (const entry of stream) result.push(entry);
  return result;
}

describe("CompositeFilesApi - mount isolation", () => {
  let root: MemFilesApi;
  let sub: MemFilesApi;
  let composite: CompositeFilesApi;

  beforeEach(() => {
    root = new MemFilesApi();
    sub = new MemFilesApi();
    composite = new CompositeFilesApi(root);
    composite.mount("/mounted", sub);
  });

  it("writes to /mounted go to sub-FS, not root", async () => {
    await composite.write("/mounted/test.txt", [toBytes("sub-content")]);
    // Should be in sub-FS
    expect(await readAll(sub.read("/test.txt"))).toBe("sub-content");
    // Should NOT be in root FS at /mounted/test.txt
    expect(await root.exists("/mounted/test.txt")).toBe(false);
  });

  it("writes to root go to root-FS, not sub", async () => {
    await composite.write("/root-file.txt", [toBytes("root-content")]);
    expect(await readAll(root.read("/root-file.txt"))).toBe("root-content");
  });

  it("reads from correct mount", async () => {
    await sub.write("/file.txt", [toBytes("from-sub")]);
    await root.write("/other.txt", [toBytes("from-root")]);

    expect(await readAll(composite.read("/mounted/file.txt"))).toBe("from-sub");
    expect(await readAll(composite.read("/other.txt"))).toBe("from-root");
  });
});

describe("CompositeFilesApi - cross-mount operations", () => {
  let root: MemFilesApi;
  let sub: MemFilesApi;
  let composite: CompositeFilesApi;

  beforeEach(() => {
    root = new MemFilesApi();
    sub = new MemFilesApi();
    composite = new CompositeFilesApi(root);
    composite.mount("/mounted", sub);
  });

  it("move from root to mounted transfers content", async () => {
    await composite.write("/source.txt", [toBytes("move-me")]);
    const result = await composite.move("/source.txt", "/mounted/dest.txt");
    expect(result).toBe(true);
    expect(await readAll(composite.read("/mounted/dest.txt"))).toBe("move-me");
    expect(await composite.exists("/source.txt")).toBe(false);
  });

  it("copy from mounted to root transfers content, preserves source", async () => {
    await composite.write("/mounted/src.txt", [toBytes("copy-me")]);
    const result = await composite.copy("/mounted/src.txt", "/dest.txt");
    expect(result).toBe(true);
    expect(await readAll(composite.read("/dest.txt"))).toBe("copy-me");
    expect(await readAll(composite.read("/mounted/src.txt"))).toBe("copy-me");
  });

  it("cross-mount directory copy works recursively", async () => {
    await composite.write("/mounted/dir/a.txt", [toBytes("aaa")]);
    await composite.write("/mounted/dir/b.txt", [toBytes("bbb")]);
    const result = await composite.copy("/mounted/dir", "/copied-dir");
    expect(result).toBe(true);
    expect(await readAll(composite.read("/copied-dir/a.txt"))).toBe("aaa");
    expect(await readAll(composite.read("/copied-dir/b.txt"))).toBe("bbb");
  });
});

describe("CompositeFilesApi - listing merge", () => {
  let root: MemFilesApi;
  let sub: MemFilesApi;
  let composite: CompositeFilesApi;

  beforeEach(() => {
    root = new MemFilesApi();
    sub = new MemFilesApi();
    composite = new CompositeFilesApi(root);
    composite.mount("/mounted", sub);
  });

  it("list / includes synthetic dir for mount point", async () => {
    await composite.write("/root-file.txt", [toBytes("x")]);
    const entries = await collectEntries(composite.list("/"));
    const names = entries.map((e) => e.name);
    expect(names).toContain("root-file.txt");
    expect(names).toContain("mounted");
    const mountEntry = entries.find((e) => e.name === "mounted");
    expect(mountEntry?.kind).toBe("directory");
    expect(mountEntry?.path).toBe("/mounted");
  });

  it("list / does not duplicate mount entry if root has dir with same name", async () => {
    await root.mkdir("/mounted");
    await composite.write("/root-file.txt", [toBytes("x")]);
    const entries = await collectEntries(composite.list("/"));
    const mountedEntries = entries.filter((e) => e.name === "mounted");
    expect(mountedEntries.length).toBe(1);
  });

  it("recursive list includes entries from child mount", async () => {
    await composite.write("/root-file.txt", [toBytes("x")]);
    await composite.write("/mounted/sub-file.txt", [toBytes("y")]);
    const entries = await collectEntries(composite.list("/", { recursive: true }));
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("/root-file.txt");
    expect(paths).toContain("/mounted");
    expect(paths).toContain("/mounted/sub-file.txt");
  });
});

describe("CompositeFilesApi - mount point protection", () => {
  let composite: CompositeFilesApi;

  beforeEach(() => {
    composite = new CompositeFilesApi(new MemFilesApi());
    composite.mount("/mounted", new MemFilesApi());
  });

  it("remove on mount point throws", async () => {
    await expect(composite.remove("/mounted")).rejects.toThrow("Cannot remove mount point");
  });

  it("stats on mount point returns directory", async () => {
    const s = await composite.stats("/mounted");
    expect(s).toEqual({ kind: "directory" });
  });

  it("exists on mount point returns true", async () => {
    expect(await composite.exists("/mounted")).toBe(true);
  });
});

describe("CompositeFilesApi - guards", () => {
  let composite: CompositeFilesApi;

  beforeEach(() => {
    composite = new CompositeFilesApi(new MemFilesApi());
    composite.guard(
      ["write", "remove", "move"],
      (path) => !path.startsWith("/.settings/"),
      "Access denied to system folder",
    );
  });

  it("guard blocks denied write", async () => {
    await expect(composite.write("/.settings/secret.json", [toBytes("x")])).rejects.toThrow(
      "Access denied to system folder: /.settings/secret.json",
    );
  });

  it("guard allows non-matching path", async () => {
    await composite.write("/allowed.txt", [toBytes("ok")]);
    expect(await readAll(composite.read("/allowed.txt"))).toBe("ok");
  });

  it("guard blocks remove on guarded path", async () => {
    // Pre-populate by writing without guard (guard only blocks /.settings/)
    await composite.write("/other.txt", [toBytes("x")]);
    await expect(composite.remove("/.settings/file.txt")).rejects.toThrow("Access denied");
  });

  it("guard blocks move to guarded path", async () => {
    await composite.write("/source.txt", [toBytes("x")]);
    await expect(composite.move("/source.txt", "/.settings/dest.txt")).rejects.toThrow(
      "Access denied",
    );
  });

  it("guard allows read on guarded path (not in operations)", async () => {
    // Write directly to underlying FS, then read through composite
    // Guard only blocks write/remove/move, not read
    const root = new MemFilesApi();
    const c = new CompositeFilesApi(root);
    c.guard(["write", "remove"], (p) => !p.startsWith("/.settings/"), "Denied");
    await root.write("/.settings/key.json", [toBytes("secret")]);
    expect(await readAll(c.read("/.settings/key.json"))).toBe("secret");
  });

  it("multiple guards: first denial wins", async () => {
    const c = new CompositeFilesApi(new MemFilesApi());
    c.guard(["write"], (p) => !p.startsWith("/a/"), "Guard A");
    c.guard(["write"], (p) => !p.startsWith("/b/"), "Guard B");
    await expect(c.write("/a/file.txt", [toBytes("x")])).rejects.toThrow("Guard A");
    await expect(c.write("/b/file.txt", [toBytes("x")])).rejects.toThrow("Guard B");
  });
});

describe("CompositeFilesApi - nested mounts", () => {
  it("deeper mount takes precedence", async () => {
    const root = new MemFilesApi();
    const shallow = new MemFilesApi();
    const deep = new MemFilesApi();
    const composite = new CompositeFilesApi(root);
    composite.mount("/a", shallow);
    composite.mount("/a/b", deep);

    await composite.write("/a/b/file.txt", [toBytes("deep-content")]);
    // Should be in deep FS
    expect(await readAll(deep.read("/file.txt"))).toBe("deep-content");
    // Should NOT be in shallow FS
    expect(await shallow.exists("/b/file.txt")).toBe(false);
  });
});
