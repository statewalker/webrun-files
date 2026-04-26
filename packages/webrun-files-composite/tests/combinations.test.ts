import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CompositeFilesApi,
  type FileGuard,
  FilteredFilesApi,
  GuardedFilesApi,
  newPathFilter,
} from "../src/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBytes(text: string): Uint8Array {
  return encoder.encode(text);
}

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  if (chunks.length === 0) return "";
  const total = chunks.reduce((acc, b) => acc + b.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return decoder.decode(result);
}

async function collectEntries<T extends { name: string; path: string; kind: string }>(
  stream: AsyncIterable<T>,
): Promise<T[]> {
  const result: T[] = [];
  for await (const entry of stream) result.push(entry);
  return result;
}

// =====================================================================
// FilteredFilesApi(CompositeFilesApi(...))
// =====================================================================

describe("Filtered ∘ Composite", () => {
  let root: MemFilesApi;
  let docs: MemFilesApi;
  let composite: CompositeFilesApi;
  let filtered: FilteredFilesApi;

  beforeEach(async () => {
    root = new MemFilesApi();
    docs = new MemFilesApi();
    composite = new CompositeFilesApi(root).mount("/docs", docs);
    await composite.write("/file.txt", [toBytes("public")]);
    await composite.write("/.system/cfg.json", [toBytes("internal")]);
    await composite.write("/docs/guide.md", [toBytes("guide")]);
    await composite.write("/docs/.draft.md", [toBytes("draft")]);
    filtered = new FilteredFilesApi(composite, newPathFilter("/.system", "/docs/.draft.md"));
  });

  it("hides root-level prefix from the composite", async () => {
    expect(await filtered.exists("/.system")).toBe(false);
    expect(await filtered.exists("/.system/cfg.json")).toBe(false);
    // But it still exists in the underlying source
    expect(await composite.exists("/.system/cfg.json")).toBe(true);
  });

  it("hides single file inside a mount", async () => {
    expect(await filtered.exists("/docs/.draft.md")).toBe(false);
    expect(await filtered.exists("/docs/guide.md")).toBe(true);
    expect(await readAll(filtered.read("/docs/guide.md"))).toBe("guide");
  });

  it("recursive list spans mount but excludes hidden paths", async () => {
    const paths = (await collectEntries(filtered.list("/", { recursive: true }))).map(
      (e) => e.path,
    );
    expect(paths).toContain("/file.txt");
    expect(paths).toContain("/docs");
    expect(paths).toContain("/docs/guide.md");
    expect(paths).not.toContain("/.system");
    expect(paths).not.toContain("/.system/cfg.json");
    expect(paths).not.toContain("/docs/.draft.md");
  });

  it("write to a hidden path is rejected even though composite would accept it", async () => {
    await expect(filtered.write("/.system/new.json", [toBytes("x")])).rejects.toThrow(/hidden/);
    expect(await composite.exists("/.system/new.json")).toBe(false);
  });

  it("move with hidden source returns false", async () => {
    expect(await filtered.move("/.system/cfg.json", "/elsewhere.json")).toBe(false);
    expect(await composite.exists("/.system/cfg.json")).toBe(true);
  });
});

// =====================================================================
// GuardedFilesApi(CompositeFilesApi(...))
// =====================================================================

describe("Guarded ∘ Composite", () => {
  it("guard sees composite-namespace paths, not backing paths", async () => {
    const root = new MemFilesApi();
    const composite = new CompositeFilesApi(root, "/projects");
    const guarded = new GuardedFilesApi(composite, [
      {
        operations: ["write"],
        check: (p) => !p.startsWith("/secret"),
        message: "no secret",
      },
    ]);
    // Composite would write to /projects/secret/x in the backing FS, but the
    // guard runs on /secret/x (composite path) — so it must block.
    await expect(guarded.write("/secret/x.txt", [toBytes("x")])).rejects.toThrow("no secret");
    expect(await root.exists("/projects/secret/x.txt")).toBe(false);

    await guarded.write("/public/y.txt", [toBytes("y")]);
    expect(await readAll(root.read("/projects/public/y.txt"))).toBe("y");
  });

  it("guard fires for cross-mount move with composite remapping", async () => {
    const root = new MemFilesApi();
    const sub = new MemFilesApi();
    const composite = new CompositeFilesApi(root).mount("/sub", sub);
    const guards: FileGuard[] = [
      {
        operations: ["move", "remove", "write"],
        check: (p) => !p.startsWith("/sub/locked"),
        message: "locked",
      },
    ];
    const guarded = new GuardedFilesApi(composite, guards);
    await composite.write("/source.txt", [toBytes("data")]);
    await expect(guarded.move("/source.txt", "/sub/locked/dest.txt")).rejects.toThrow("locked");
    // No write happened on either backend at the locked target.
    expect(await sub.exists("/locked/dest.txt")).toBe(false);
  });

  it("mount-point protection survives wrapping", async () => {
    const composite = new CompositeFilesApi(new MemFilesApi()).mount("/mounted", new MemFilesApi());
    const guarded = new GuardedFilesApi(composite, []);
    await expect(guarded.remove("/mounted")).rejects.toThrow("Cannot remove mount point");
  });
});

// =====================================================================
// GuardedFilesApi(FilteredFilesApi(...))
// =====================================================================

describe("Guarded ∘ Filtered", () => {
  it("guard rejection wins over filter (since guard runs first)", async () => {
    const source = new MemFilesApi();
    const filtered = new FilteredFilesApi(source, newPathFilter("/hidden"));
    const guarded = new GuardedFilesApi(filtered, [
      {
        operations: ["write"],
        check: (p) => !p.startsWith("/hidden"),
        message: "guard-block",
      },
    ]);
    await expect(guarded.write("/hidden/x.txt", [toBytes("x")])).rejects.toThrow("guard-block");
  });

  it("filter still hides paths the guard allows", async () => {
    const source = new MemFilesApi();
    await source.write("/hidden/secret.txt", [toBytes("s")]);
    await source.write("/visible.txt", [toBytes("v")]);
    const filtered = new FilteredFilesApi(source, newPathFilter("/hidden"));
    const guarded = new GuardedFilesApi(filtered, []); // no guards
    expect(await guarded.exists("/hidden/secret.txt")).toBe(false);
    expect(await guarded.exists("/visible.txt")).toBe(true);
    expect(await readAll(guarded.read("/hidden/secret.txt"))).toBe(""); // empty stream
    expect(await readAll(guarded.read("/visible.txt"))).toBe("v");
  });
});

// =====================================================================
// FilteredFilesApi(GuardedFilesApi(...))
// =====================================================================

describe("Filtered ∘ Guarded", () => {
  it("filter hides paths even though guard would allow them", async () => {
    const source = new MemFilesApi();
    await source.write("/visible.txt", [toBytes("v")]);
    await source.write("/hidden.txt", [toBytes("h")]);
    const guarded = new GuardedFilesApi(source, []); // permissive
    const filtered = new FilteredFilesApi(guarded, newPathFilter("/hidden.txt"));
    expect(await filtered.exists("/hidden.txt")).toBe(false);
    expect(await filtered.exists("/visible.txt")).toBe(true);
  });

  it("guard violations bubble through filter for non-hidden paths", async () => {
    const source = new MemFilesApi();
    const guarded = new GuardedFilesApi(source, [
      { operations: ["write"], check: (p) => p !== "/blocked.txt", message: "blocked" },
    ]);
    const filtered = new FilteredFilesApi(guarded, newPathFilter("/hidden"));
    await expect(filtered.write("/blocked.txt", [toBytes("x")])).rejects.toThrow("blocked");
    // For a hidden path, the filter intercepts before the guard runs.
    await expect(filtered.write("/hidden/x.txt", [toBytes("x")])).rejects.toThrow(/hidden/);
  });
});

// =====================================================================
// CompositeFilesApi mounting Filtered/Guarded backends
// =====================================================================

describe("Composite mounting Filtered/Guarded backends", () => {
  it("mounted FilteredFilesApi hides paths within the mount namespace", async () => {
    const docsBacking = new MemFilesApi();
    await docsBacking.write("/public.md", [toBytes("p")]);
    await docsBacking.write("/private.md", [toBytes("priv")]);
    const filteredDocs = new FilteredFilesApi(docsBacking, newPathFilter("/private.md"));
    const composite = new CompositeFilesApi(new MemFilesApi()).mount("/docs", filteredDocs);

    expect(await composite.exists("/docs/public.md")).toBe(true);
    expect(await composite.exists("/docs/private.md")).toBe(false);
    const names = (await collectEntries(composite.list("/docs"))).map((e) => e.name);
    expect(names).toContain("public.md");
    expect(names).not.toContain("private.md");
  });

  it("mounted GuardedFilesApi enforces guards in mount-local namespace", async () => {
    const cacheBacking = new MemFilesApi();
    const guardedCache = new GuardedFilesApi(cacheBacking, [
      { operations: ["write"], check: (p) => !p.endsWith(".tmp"), message: "no tmp" },
    ]);
    const composite = new CompositeFilesApi(new MemFilesApi()).mount("/cache", guardedCache);

    // Path passed to the mounted backend is relative to the mount root,
    // i.e. "/file.tmp" — guards run there.
    await expect(composite.write("/cache/x.tmp", [toBytes("x")])).rejects.toThrow("no tmp");
    await composite.write("/cache/x.dat", [toBytes("y")]);
    expect(await readAll(cacheBacking.read("/x.dat"))).toBe("y");
  });
});

// =====================================================================
// Three-layer stack: Guarded ∘ Filtered ∘ Composite
// =====================================================================

describe("Guarded ∘ Filtered ∘ Composite (full stack)", () => {
  let root: MemFilesApi;
  let docs: MemFilesApi;
  let stack: GuardedFilesApi;

  beforeEach(async () => {
    root = new MemFilesApi();
    docs = new MemFilesApi();
    const composite = new CompositeFilesApi(root).mount("/docs", docs, "/documentation");
    await composite.write("/readme.md", [toBytes("readme")]);
    await composite.write("/.system/cfg.json", [toBytes("internal")]);
    await composite.write("/docs/guide.md", [toBytes("guide")]);
    const filtered = new FilteredFilesApi(composite, newPathFilter("/.system"));
    stack = new GuardedFilesApi(filtered, [
      {
        operations: ["write", "remove"],
        check: (p) => !p.startsWith("/docs/internal"),
        message: "internal",
      },
    ]);
  });

  it("reads pass through all layers for visible/allowed paths", async () => {
    expect(await readAll(stack.read("/readme.md"))).toBe("readme");
    expect(await readAll(stack.read("/docs/guide.md"))).toBe("guide");
  });

  it("filter hides system folder", async () => {
    expect(await stack.exists("/.system")).toBe(false);
    expect(await stack.exists("/.system/cfg.json")).toBe(false);
  });

  it("guard blocks writes inside protected folder", async () => {
    await expect(stack.write("/docs/internal/secret.md", [toBytes("x")])).rejects.toThrow(
      "internal",
    );
    expect(await docs.exists("/documentation/internal/secret.md")).toBe(false);
  });

  it("recursive list across mount/filter/guard returns expected paths", async () => {
    const paths = (await collectEntries(stack.list("/", { recursive: true }))).map((e) => e.path);
    expect(paths).toContain("/readme.md");
    expect(paths).toContain("/docs");
    expect(paths).toContain("/docs/guide.md");
    expect(paths).not.toContain("/.system");
    expect(paths).not.toContain("/.system/cfg.json");
  });

  it("backing filesystems still hold the data outside the stack's view", async () => {
    expect(await root.exists("/.system/cfg.json")).toBe(true);
    expect(await readAll(docs.read("/documentation/guide.md"))).toBe("guide");
  });
});
