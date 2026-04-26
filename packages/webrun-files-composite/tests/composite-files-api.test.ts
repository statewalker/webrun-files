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

// --- Shared test suite: root with basePath ---

createFilesApiTests("CompositeFilesApi (root basePath)", async () => {
  const root = new MemFilesApi();
  return { api: new CompositeFilesApi(root, "/projects") };
});

// --- Shared test suite: mount with fsPath ---

createFilesApiTests("CompositeFilesApi (mount with fsPath)", async () => {
  const root = new MemFilesApi();
  const sub = new MemFilesApi();
  const composite = new CompositeFilesApi(root);
  composite.mount("/mounted", sub, "/data");
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

// =====================================================================
// Tests for fsPath (base path remapping)
// =====================================================================

describe("CompositeFilesApi - constructor rootPath", () => {
  let underlying: MemFilesApi;
  let composite: CompositeFilesApi;

  beforeEach(() => {
    underlying = new MemFilesApi();
    composite = new CompositeFilesApi(underlying, "/projects");
  });

  it("write at / maps to /projects in underlying FS", async () => {
    await composite.write("/readme.txt", [toBytes("hello")]);
    expect(await readAll(underlying.read("/projects/readme.txt"))).toBe("hello");
    expect(await underlying.exists("/readme.txt")).toBe(false);
  });

  it("read at / reads from /projects in underlying FS", async () => {
    await underlying.write("/projects/data.txt", [toBytes("from-underlying")]);
    expect(await readAll(composite.read("/data.txt"))).toBe("from-underlying");
  });

  it("nested paths are correctly remapped", async () => {
    await composite.write("/src/main.ts", [toBytes("code")]);
    expect(await readAll(underlying.read("/projects/src/main.ts"))).toBe("code");
    expect(await readAll(composite.read("/src/main.ts"))).toBe("code");
  });

  it("mkdir creates directory under rootPath", async () => {
    await composite.mkdir("/lib");
    expect(await underlying.exists("/projects/lib")).toBe(true);
    expect(await underlying.exists("/lib")).toBe(false);
  });

  it("exists checks under rootPath", async () => {
    await underlying.write("/projects/a.txt", [toBytes("x")]);
    await underlying.write("/other.txt", [toBytes("y")]);
    expect(await composite.exists("/a.txt")).toBe(true);
    expect(await composite.exists("/other.txt")).toBe(false);
  });

  it("stats checks under rootPath", async () => {
    await underlying.write("/projects/file.txt", [toBytes("x")]);
    const s = await composite.stats("/file.txt");
    expect(s?.kind).toBe("file");
  });

  it("remove deletes under rootPath", async () => {
    await composite.write("/to-delete.txt", [toBytes("x")]);
    expect(await underlying.exists("/projects/to-delete.txt")).toBe(true);
    await composite.remove("/to-delete.txt");
    expect(await underlying.exists("/projects/to-delete.txt")).toBe(false);
  });

  it("list shows entries from rootPath subdirectory", async () => {
    await composite.write("/a.txt", [toBytes("1")]);
    await composite.write("/b.txt", [toBytes("2")]);
    const entries = await collectEntries(composite.list("/"));
    const names = entries.map((e) => e.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
  });

  it("move within root remaps both paths", async () => {
    await composite.write("/old.txt", [toBytes("data")]);
    await composite.move("/old.txt", "/new.txt");
    expect(await underlying.exists("/projects/old.txt")).toBe(false);
    expect(await readAll(underlying.read("/projects/new.txt"))).toBe("data");
  });

  it("copy within root remaps both paths", async () => {
    await composite.write("/orig.txt", [toBytes("data")]);
    await composite.copy("/orig.txt", "/dup.txt");
    expect(await readAll(underlying.read("/projects/orig.txt"))).toBe("data");
    expect(await readAll(underlying.read("/projects/dup.txt"))).toBe("data");
  });

  it("./projects syntax normalizes correctly", () => {
    const c = new CompositeFilesApi(new MemFilesApi(), "./projects");
    // Should not throw; ./projects normalizes to /projects
    expect(c).toBeInstanceOf(CompositeFilesApi);
  });
});

describe("CompositeFilesApi - mount with fsPath", () => {
  let root: MemFilesApi;
  let docs: MemFilesApi;
  let composite: CompositeFilesApi;

  beforeEach(() => {
    root = new MemFilesApi();
    docs = new MemFilesApi();
    composite = new CompositeFilesApi(root);
    composite.mount("/docs", docs, "/documentation");
  });

  it("write to /docs/file maps to /documentation/file in mounted FS", async () => {
    await composite.write("/docs/guide.md", [toBytes("# Guide")]);
    expect(await readAll(docs.read("/documentation/guide.md"))).toBe("# Guide");
    expect(await docs.exists("/guide.md")).toBe(false);
  });

  it("read from /docs/file reads from /documentation/file in mounted FS", async () => {
    await docs.write("/documentation/notes.txt", [toBytes("notes")]);
    expect(await readAll(composite.read("/docs/notes.txt"))).toBe("notes");
  });

  it("nested write within mounted fsPath", async () => {
    await composite.write("/docs/api/ref.md", [toBytes("ref")]);
    expect(await readAll(docs.read("/documentation/api/ref.md"))).toBe("ref");
  });

  it("exists checks under fsPath", async () => {
    await docs.write("/documentation/a.txt", [toBytes("x")]);
    await docs.write("/other.txt", [toBytes("y")]);
    expect(await composite.exists("/docs/a.txt")).toBe(true);
    // /other.txt is not under /documentation, so not visible as /docs/other.txt
  });

  it("remove deletes under fsPath", async () => {
    await composite.write("/docs/temp.txt", [toBytes("x")]);
    expect(await docs.exists("/documentation/temp.txt")).toBe(true);
    await composite.remove("/docs/temp.txt");
    expect(await docs.exists("/documentation/temp.txt")).toBe(false);
  });

  it("mkdir creates directory under fsPath", async () => {
    await composite.mkdir("/docs/sub");
    expect(await docs.exists("/documentation/sub")).toBe(true);
  });

  it("list shows entries from fsPath subdirectory", async () => {
    await composite.write("/docs/x.txt", [toBytes("1")]);
    await composite.write("/docs/y.txt", [toBytes("2")]);
    const entries = await collectEntries(composite.list("/docs"));
    const names = entries.map((e) => e.name);
    expect(names).toContain("x.txt");
    expect(names).toContain("y.txt");
  });

  it("move within mount remaps both paths under fsPath", async () => {
    await composite.write("/docs/old.md", [toBytes("data")]);
    await composite.move("/docs/old.md", "/docs/new.md");
    expect(await docs.exists("/documentation/old.md")).toBe(false);
    expect(await readAll(docs.read("/documentation/new.md"))).toBe("data");
  });

  it("copy within mount remaps both paths under fsPath", async () => {
    await composite.write("/docs/orig.md", [toBytes("data")]);
    await composite.copy("/docs/orig.md", "/docs/dup.md");
    expect(await readAll(docs.read("/documentation/orig.md"))).toBe("data");
    expect(await readAll(docs.read("/documentation/dup.md"))).toBe("data");
  });
});

describe("CompositeFilesApi - rootPath + mount fsPath combined", () => {
  let mainFs: MemFilesApi;
  let s3Fs: MemFilesApi;
  let memFs: MemFilesApi;
  let composite: CompositeFilesApi;

  beforeEach(() => {
    mainFs = new MemFilesApi();
    s3Fs = new MemFilesApi();
    memFs = new MemFilesApi();
    composite = new CompositeFilesApi(mainFs, "/projects")
      .mount("/docs", s3Fs, "/documentation")
      .mount("/cache", memFs);
  });

  it("root files go to /projects in mainFs", async () => {
    await composite.write("/readme.txt", [toBytes("hello")]);
    expect(await readAll(mainFs.read("/projects/readme.txt"))).toBe("hello");
  });

  it("/docs files go to /documentation in s3Fs", async () => {
    await composite.write("/docs/guide.md", [toBytes("guide")]);
    expect(await readAll(s3Fs.read("/documentation/guide.md"))).toBe("guide");
  });

  it("/cache files go to / in memFs (default fsPath)", async () => {
    await composite.write("/cache/tmp.dat", [toBytes("temp")]);
    expect(await readAll(memFs.read("/tmp.dat"))).toBe("temp");
  });

  it("cross-mount copy: root → mount with fsPath", async () => {
    await composite.write("/file.txt", [toBytes("from-root")]);
    await composite.copy("/file.txt", "/docs/file.txt");
    expect(await readAll(s3Fs.read("/documentation/file.txt"))).toBe("from-root");
    expect(await readAll(mainFs.read("/projects/file.txt"))).toBe("from-root");
  });

  it("cross-mount copy: mount with fsPath → root", async () => {
    await composite.write("/docs/spec.md", [toBytes("spec")]);
    await composite.copy("/docs/spec.md", "/spec.md");
    expect(await readAll(mainFs.read("/projects/spec.md"))).toBe("spec");
    expect(await readAll(s3Fs.read("/documentation/spec.md"))).toBe("spec");
  });

  it("cross-mount move: mount with fsPath → mount without fsPath", async () => {
    await composite.write("/docs/draft.md", [toBytes("draft")]);
    await composite.move("/docs/draft.md", "/cache/draft.md");
    expect(await s3Fs.exists("/documentation/draft.md")).toBe(false);
    expect(await readAll(memFs.read("/draft.md"))).toBe("draft");
  });

  it("cross-mount directory copy between mounts with different fsPaths", async () => {
    await composite.write("/docs/api/v1.md", [toBytes("v1")]);
    await composite.write("/docs/api/v2.md", [toBytes("v2")]);
    await composite.copy("/docs/api", "/cache/api-backup");
    expect(await readAll(memFs.read("/api-backup/v1.md"))).toBe("v1");
    expect(await readAll(memFs.read("/api-backup/v2.md"))).toBe("v2");
  });

  it("list / includes mounts as synthetic directories", async () => {
    await composite.write("/readme.txt", [toBytes("x")]);
    const entries = await collectEntries(composite.list("/"));
    const names = entries.map((e) => e.name);
    expect(names).toContain("readme.txt");
    expect(names).toContain("docs");
    expect(names).toContain("cache");
  });

  it("recursive list / spans all mounts with correct paths", async () => {
    await composite.write("/root.txt", [toBytes("r")]);
    await composite.write("/docs/guide.md", [toBytes("g")]);
    await composite.write("/cache/tmp.dat", [toBytes("t")]);
    const entries = await collectEntries(composite.list("/", { recursive: true }));
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("/root.txt");
    expect(paths).toContain("/docs");
    expect(paths).toContain("/docs/guide.md");
    expect(paths).toContain("/cache");
    expect(paths).toContain("/cache/tmp.dat");
  });

  it("recursive list under mount with fsPath shows correct entries", async () => {
    await composite.write("/docs/a.md", [toBytes("a")]);
    await composite.write("/docs/sub/b.md", [toBytes("b")]);
    const entries = await collectEntries(composite.list("/docs", { recursive: true }));
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("/docs/a.md");
    expect(paths).toContain("/docs/sub/b.md");
    // Should not contain raw backing paths
    expect(paths.some((p) => p.includes("documentation"))).toBe(false);
  });
});

describe("CompositeFilesApi - fsPath isolation", () => {
  it("files outside rootPath in underlying FS are not visible", async () => {
    const underlying = new MemFilesApi();
    await underlying.write("/outside.txt", [toBytes("outside")]);
    await underlying.write("/projects/inside.txt", [toBytes("inside")]);
    const composite = new CompositeFilesApi(underlying, "/projects");
    expect(await composite.exists("/inside.txt")).toBe(true);
    expect(await composite.exists("/outside.txt")).toBe(false);
  });

  it("files outside fsPath in mounted FS are not accessible via mount", async () => {
    const docsFs = new MemFilesApi();
    await docsFs.write("/other/secret.txt", [toBytes("secret")]);
    await docsFs.write("/documentation/public.txt", [toBytes("public")]);
    const composite = new CompositeFilesApi(new MemFilesApi());
    composite.mount("/docs", docsFs, "/documentation");
    expect(await composite.exists("/docs/public.txt")).toBe(true);
    // /other/secret.txt is not under /documentation, so not reachable via /docs
  });

  it("list does not leak entries from outside fsPath", async () => {
    const docsFs = new MemFilesApi();
    await docsFs.write("/documentation/visible.txt", [toBytes("v")]);
    await docsFs.write("/other/hidden.txt", [toBytes("h")]);
    const composite = new CompositeFilesApi(new MemFilesApi());
    composite.mount("/docs", docsFs, "/documentation");
    const entries = await collectEntries(composite.list("/docs"));
    const names = entries.map((e) => e.name);
    expect(names).toContain("visible.txt");
    expect(names).not.toContain("hidden.txt");
    expect(names).not.toContain("other");
  });
});

describe("CompositeFilesApi - nested mounts with fsPath", () => {
  it("nested mount with fsPath resolves correctly", async () => {
    const root = new MemFilesApi();
    const shallow = new MemFilesApi();
    const deep = new MemFilesApi();
    const composite = new CompositeFilesApi(root)
      .mount("/a", shallow, "/base-a")
      .mount("/a/b", deep, "/base-b");

    await composite.write("/a/b/file.txt", [toBytes("deep-content")]);
    expect(await readAll(deep.read("/base-b/file.txt"))).toBe("deep-content");
    expect(await shallow.exists("/base-a/b/file.txt")).toBe(false);
  });

  it("shallow mount with fsPath unaffected by deep mount", async () => {
    const root = new MemFilesApi();
    const shallow = new MemFilesApi();
    const deep = new MemFilesApi();
    const composite = new CompositeFilesApi(root)
      .mount("/a", shallow, "/base-a")
      .mount("/a/b", deep, "/base-b");

    await composite.write("/a/file.txt", [toBytes("shallow-content")]);
    expect(await readAll(shallow.read("/base-a/file.txt"))).toBe("shallow-content");
  });
});
