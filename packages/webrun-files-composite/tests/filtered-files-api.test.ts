import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FilteredFilesApi,
  newGlobPathFilter,
  newPathFilter,
  newRegexpPathFilter,
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

// ---------------------------------------------------------------
// Shared FilesApi suite — empty filter must behave like the source
// ---------------------------------------------------------------

createFilesApiTests("FilteredFilesApi (no filter)", async () => ({
  api: new FilteredFilesApi(new MemFilesApi(), () => true),
}));

createFilesApiTests("FilteredFilesApi (no prefixes)", async () => ({
  api: new FilteredFilesApi(new MemFilesApi(), newPathFilter()),
}));

createFilesApiTests("FilteredFilesApi (filter that misses every path)", async () => ({
  api: new FilteredFilesApi(new MemFilesApi(), newPathFilter("/__never_used__")),
}));

// ---------------------------------------------------------------
// newPathFilter — pure function tests
// ---------------------------------------------------------------

describe("newPathFilter", () => {
  it("no prefixes means nothing is hidden", () => {
    const filter = newPathFilter();
    expect(filter("/")).toBe(true);
    expect(filter("/foo")).toBe(true);
    expect(filter("/foo/bar")).toBe(true);
  });

  it("single prefix hides matching path and descendants", () => {
    const filter = newPathFilter("/private");
    expect(filter("/private")).toBe(false);
    expect(filter("/private/secret.txt")).toBe(false);
    expect(filter("/private/sub/file.txt")).toBe(false);
    expect(filter("/public/file.txt")).toBe(true);
    expect(filter("/")).toBe(true);
  });

  it("does not hide a sibling that shares a prefix substring", () => {
    const filter = newPathFilter("/priv");
    // "/private" is NOT under "/priv" because there's no "/" boundary
    expect(filter("/private")).toBe(true);
    expect(filter("/priv")).toBe(false);
    expect(filter("/priv/x")).toBe(false);
  });

  it("multiple prefixes hide all matching paths", () => {
    const filter = newPathFilter("/a", "/b/c");
    expect(filter("/a")).toBe(false);
    expect(filter("/a/x")).toBe(false);
    expect(filter("/b/c")).toBe(false);
    expect(filter("/b/c/x")).toBe(false);
    expect(filter("/b")).toBe(true);
    expect(filter("/b/d")).toBe(true);
    expect(filter("/c")).toBe(true);
  });

  it("normalizes input prefixes (adds leading slash, strips trailing slash)", () => {
    const filter = newPathFilter("foo", "bar/", "/baz/");
    expect(filter("/foo")).toBe(false);
    expect(filter("/foo/x")).toBe(false);
    expect(filter("/bar")).toBe(false);
    expect(filter("/bar/x")).toBe(false);
    expect(filter("/baz")).toBe(false);
    expect(filter("/baz/x")).toBe(false);
  });

  it("normalizes paths under test (handles missing slashes/trailing slashes)", () => {
    const filter = newPathFilter("/private");
    expect(filter("private")).toBe(false);
    expect(filter("/private/")).toBe(false);
    expect(filter("private/sub")).toBe(false);
  });

  it("ignores empty / root prefix entries (they would hide everything)", () => {
    const filter = newPathFilter("", "/", "/keep-this");
    expect(filter("/anything")).toBe(true);
    expect(filter("/keep-this")).toBe(false);
  });
});

// ---------------------------------------------------------------
// newRegexpPathFilter — pure function tests
// ---------------------------------------------------------------

describe("newRegexpPathFilter", () => {
  it("no regexps means nothing is hidden", () => {
    const filter = newRegexpPathFilter();
    expect(filter("/")).toBe(true);
    expect(filter("/foo")).toBe(true);
    expect(filter("/foo/bar")).toBe(true);
  });

  it("single regexp hides any matching path", () => {
    const filter = newRegexpPathFilter(/\.log$/);
    expect(filter("/build.log")).toBe(false);
    expect(filter("/dir/sub.log")).toBe(false);
    expect(filter("/build.txt")).toBe(true);
    expect(filter("/log")).toBe(true);
  });

  it("matches against the normalized path (single leading slash, no trailing)", () => {
    const filter = newRegexpPathFilter(/^\/foo\/bar$/);
    expect(filter("foo/bar")).toBe(false);
    expect(filter("/foo/bar/")).toBe(false);
    expect(filter("//foo//bar//")).toBe(false);
  });

  it("multiple regexps: any match hides the path", () => {
    const filter = newRegexpPathFilter(/\.log$/, /^\/tmp\//, /\/\.[^/]+$/);
    // matches /\.log$/
    expect(filter("/build.log")).toBe(false);
    // matches /^\/tmp\//
    expect(filter("/tmp/x.txt")).toBe(false);
    // matches /\/\.[^/]+$/  (dotfile)
    expect(filter("/.env")).toBe(false);
    expect(filter("/sub/.env")).toBe(false);
    // none match
    expect(filter("/src/index.ts")).toBe(true);
    expect(filter("/src/.subdir/file.ts")).toBe(true); // dotfile rule only matches basename
  });

  it("anchors work as expected (^ matches start of normalized path)", () => {
    const filter = newRegexpPathFilter(/^\/private/);
    expect(filter("/private")).toBe(false);
    expect(filter("/private/x")).toBe(false);
    expect(filter("/sub/private")).toBe(true); // not anchored at /sub
  });

  it("regexp without anchors matches anywhere", () => {
    const filter = newRegexpPathFilter(/secret/);
    expect(filter("/secret.txt")).toBe(false);
    expect(filter("/dir/topsecret/file")).toBe(false);
    expect(filter("/dir/file")).toBe(true);
  });
});

createFilesApiTests("FilteredFilesApi (no regexps)", async () => ({
  api: new FilteredFilesApi(new MemFilesApi(), newRegexpPathFilter()),
}));

createFilesApiTests("FilteredFilesApi (regexp that misses every path)", async () => ({
  api: new FilteredFilesApi(new MemFilesApi(), newRegexpPathFilter(/__never_used__/)),
}));

describe("FilteredFilesApi with newRegexpPathFilter - end-to-end", () => {
  let source: MemFilesApi;
  let api: FilteredFilesApi;

  beforeEach(async () => {
    source = new MemFilesApi();
    await source.write("/keep.md", [toBytes("k")]);
    await source.write("/build.log", [toBytes("l")]);
    await source.write("/.env", [toBytes("e")]);
    await source.write("/dir/inner.log", [toBytes("i")]);
    api = new FilteredFilesApi(source, newRegexpPathFilter(/\.log$/, /\/\.[^/]+$/));
  });

  it("hides regexp-matched files via list", async () => {
    const paths = (await collectEntries(api.list("/", { recursive: true }))).map((e) => e.path);
    expect(paths).toContain("/keep.md");
    expect(paths).toContain("/dir");
    expect(paths).not.toContain("/build.log");
    expect(paths).not.toContain("/.env");
    expect(paths).not.toContain("/dir/inner.log");
  });

  it("exists is false for regexp-matched paths", async () => {
    expect(await api.exists("/keep.md")).toBe(true);
    expect(await api.exists("/build.log")).toBe(false);
    expect(await api.exists("/.env")).toBe(false);
  });

  it("write to a regexp-matched path is rejected", async () => {
    await expect(api.write("/new.log", [toBytes("x")])).rejects.toThrow(/hidden/);
    expect(await source.exists("/new.log")).toBe(false);
  });
});

// ---------------------------------------------------------------
// newGlobPathFilter — pure function tests
// ---------------------------------------------------------------

describe("newGlobPathFilter", () => {
  it("no globs means nothing is hidden", () => {
    const filter = newGlobPathFilter();
    expect(filter("/")).toBe(true);
    expect(filter("/foo")).toBe(true);
    expect(filter("/foo/bar")).toBe(true);
  });

  it("single glob hides matching paths within one segment", () => {
    // `*` does not cross `/` (globstar mode is enabled)
    const filter = newGlobPathFilter("/tmp/*");
    expect(filter("/tmp/x.txt")).toBe(false);
    expect(filter("/tmp/y.dat")).toBe(false);
    expect(filter("/tmp/sub/x.txt")).toBe(true);
    expect(filter("/other/x.txt")).toBe(true);
  });

  it("`**` spans any number of path segments", () => {
    const filter = newGlobPathFilter("/.git/**");
    expect(filter("/.git/HEAD")).toBe(false);
    expect(filter("/.git/refs/heads/main")).toBe(false);
    expect(filter("/notgit")).toBe(true);
    expect(filter("/src/file.ts")).toBe(true);
  });

  it("leading `**​/` matches anywhere in the tree", () => {
    const filter = newGlobPathFilter("**/*.log");
    expect(filter("/build.log")).toBe(false);
    expect(filter("/sub/build.log")).toBe(false);
    expect(filter("/a/b/c/build.log")).toBe(false);
    expect(filter("/build.txt")).toBe(true);
  });

  it("`/foo/**` matches descendants only, NOT the prefix itself", () => {
    // `/.git/**` requires a trailing `/` after `.git`, so `/.git` is not
    // matched. To hide both, list both: `/.git`, `/.git/**`.
    const filter = newGlobPathFilter("/.git/**");
    expect(filter("/.git")).toBe(true); // visible
    expect(filter("/.git/HEAD")).toBe(false); // hidden
  });

  it("listing both prefix and `prefix/**` hides the directory and its contents", () => {
    const filter = newGlobPathFilter("/.git", "/.git/**");
    expect(filter("/.git")).toBe(false);
    expect(filter("/.git/HEAD")).toBe(false);
    expect(filter("/.gitignore")).toBe(true);
  });

  it("supports `?` (single-char) and `[]` (character class)", () => {
    const filter = newGlobPathFilter("/file-?.txt");
    expect(filter("/file-a.txt")).toBe(false);
    expect(filter("/file-b.txt")).toBe(false);
    expect(filter("/file-ab.txt")).toBe(true);

    const cls = newGlobPathFilter("/log-[0-9].txt");
    expect(cls("/log-3.txt")).toBe(false);
    expect(cls("/log-x.txt")).toBe(true);
  });

  it("supports `{a,b,c}` alternation", () => {
    const filter = newGlobPathFilter("/.{git,svn,hg}/**");
    expect(filter("/.git/HEAD")).toBe(false);
    expect(filter("/.svn/wc.db")).toBe(false);
    expect(filter("/.hg/store")).toBe(false);
    expect(filter("/.bzr/HEAD")).toBe(true);
  });

  it("multiple globs: any match hides the path", () => {
    const filter = newGlobPathFilter("**/*.log", "/.git/**", "/tmp/**");
    expect(filter("/src/index.ts")).toBe(true);
    expect(filter("/build.log")).toBe(false);
    expect(filter("/sub/build.log")).toBe(false);
    expect(filter("/.git/HEAD")).toBe(false);
    expect(filter("/tmp/x")).toBe(false);
    expect(filter("/tmp/sub/x")).toBe(false);
  });

  it("normalizes the path under test (handles missing leading slash, trailing slash)", () => {
    const filter = newGlobPathFilter("/.git/**");
    expect(filter(".git/HEAD")).toBe(false);
    expect(filter("/.git/HEAD/")).toBe(false);
    expect(filter("//.git//HEAD//")).toBe(false);
  });

  it("a glob that matches no path leaves everything visible", () => {
    const filter = newGlobPathFilter("/__never_used__/**");
    expect(filter("/a")).toBe(true);
    expect(filter("/foo/bar")).toBe(true);
  });
});

createFilesApiTests("FilteredFilesApi (no globs)", async () => ({
  api: new FilteredFilesApi(new MemFilesApi(), newGlobPathFilter()),
}));

createFilesApiTests("FilteredFilesApi (glob that misses every path)", async () => ({
  api: new FilteredFilesApi(new MemFilesApi(), newGlobPathFilter("/__never_used__/**")),
}));

describe("FilteredFilesApi with newGlobPathFilter - end-to-end", () => {
  let source: MemFilesApi;
  let api: FilteredFilesApi;

  beforeEach(async () => {
    source = new MemFilesApi();
    await source.write("/keep.md", [toBytes("k")]);
    await source.write("/build.log", [toBytes("l")]);
    await source.write("/.git/HEAD", [toBytes("g")]);
    await source.write("/.git/refs/heads/main", [toBytes("m")]);
    await source.write("/dir/inner.log", [toBytes("i")]);
    api = new FilteredFilesApi(source, newGlobPathFilter("**/*.log", "/.git", "/.git/**"));
  });

  it("hides glob-matched files via recursive list", async () => {
    const paths = (await collectEntries(api.list("/", { recursive: true }))).map((e) => e.path);
    expect(paths).toContain("/keep.md");
    expect(paths).toContain("/dir");
    expect(paths).not.toContain("/build.log");
    expect(paths).not.toContain("/.git");
    expect(paths).not.toContain("/.git/HEAD");
    expect(paths).not.toContain("/.git/refs/heads/main");
    expect(paths).not.toContain("/dir/inner.log");
  });

  it("exists is false for glob-matched paths", async () => {
    expect(await api.exists("/keep.md")).toBe(true);
    expect(await api.exists("/build.log")).toBe(false);
    expect(await api.exists("/.git/HEAD")).toBe(false);
  });

  it("write to a glob-matched path is rejected", async () => {
    await expect(api.write("/new.log", [toBytes("x")])).rejects.toThrow(/hidden/);
    await expect(api.write("/.git/CONFIG", [toBytes("x")])).rejects.toThrow(/hidden/);
    expect(await source.exists("/new.log")).toBe(false);
    expect(await source.exists("/.git/CONFIG")).toBe(false);
  });
});

// ---------------------------------------------------------------
// FilteredFilesApi — per-operation behavior against real MemFilesApi
// ---------------------------------------------------------------

describe("FilteredFilesApi - read", () => {
  let source: MemFilesApi;
  let api: FilteredFilesApi;

  beforeEach(async () => {
    source = new MemFilesApi();
    await source.write("/visible.txt", [toBytes("ok")]);
    await source.write("/private/secret.txt", [toBytes("nope")]);
    api = new FilteredFilesApi(source, newPathFilter("/private"));
  });

  it("reads visible files normally", async () => {
    expect(await readAll(api.read("/visible.txt"))).toBe("ok");
  });

  it("hidden file reads as empty stream", async () => {
    expect(await readAll(api.read("/private/secret.txt"))).toBe("");
  });

  it("hidden directory itself reads as empty stream", async () => {
    expect(await readAll(api.read("/private"))).toBe("");
  });

  it("does not invoke source.read for hidden paths", async () => {
    let invoked = false;
    const wrapped = new FilteredFilesApi(
      {
        ...source,
        read(path: string) {
          invoked = true;
          return source.read(path);
        },
      } as MemFilesApi,
      newPathFilter("/private"),
    );
    await readAll(wrapped.read("/private/secret.txt"));
    expect(invoked).toBe(false);
  });
});

describe("FilteredFilesApi - write", () => {
  let source: MemFilesApi;
  let api: FilteredFilesApi;

  beforeEach(() => {
    source = new MemFilesApi();
    api = new FilteredFilesApi(source, newPathFilter("/private"));
  });

  it("writes visible files through to source", async () => {
    await api.write("/visible.txt", [toBytes("ok")]);
    expect(await readAll(source.read("/visible.txt"))).toBe("ok");
  });

  it("rejects writes to hidden paths", async () => {
    await expect(api.write("/private/secret.txt", [toBytes("nope")])).rejects.toThrow(/hidden/);
    expect(await source.exists("/private/secret.txt")).toBe(false);
  });

  it("rejects writes at the hidden directory itself", async () => {
    await expect(api.write("/private", [toBytes("x")])).rejects.toThrow(/hidden/);
  });
});

describe("FilteredFilesApi - mkdir", () => {
  let source: MemFilesApi;
  let api: FilteredFilesApi;

  beforeEach(() => {
    source = new MemFilesApi();
    api = new FilteredFilesApi(source, newPathFilter("/private"));
  });

  it("creates visible directories", async () => {
    await api.mkdir("/public");
    expect(await source.exists("/public")).toBe(true);
  });

  it("rejects mkdir on hidden paths", async () => {
    await expect(api.mkdir("/private")).rejects.toThrow(/hidden/);
    await expect(api.mkdir("/private/sub")).rejects.toThrow(/hidden/);
    expect(await source.exists("/private")).toBe(false);
  });
});

describe("FilteredFilesApi - list", () => {
  let source: MemFilesApi;
  let api: FilteredFilesApi;

  beforeEach(async () => {
    source = new MemFilesApi();
    await source.write("/visible.txt", [toBytes("v")]);
    await source.write("/private/secret.txt", [toBytes("s")]);
    await source.write("/data/inner.txt", [toBytes("d")]);
    await source.write("/data/private/leak.txt", [toBytes("l")]);
    api = new FilteredFilesApi(source, newPathFilter("/private", "/data/private"));
  });

  it("non-recursive list omits hidden entries", async () => {
    const entries = await collectEntries(api.list("/"));
    const names = entries.map((e) => e.name);
    expect(names).toContain("visible.txt");
    expect(names).toContain("data");
    expect(names).not.toContain("private");
  });

  it("recursive list omits all descendants of hidden prefixes", async () => {
    const entries = await collectEntries(api.list("/", { recursive: true }));
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("/visible.txt");
    expect(paths).toContain("/data");
    expect(paths).toContain("/data/inner.txt");
    expect(paths).not.toContain("/private");
    expect(paths).not.toContain("/private/secret.txt");
    expect(paths).not.toContain("/data/private");
    expect(paths).not.toContain("/data/private/leak.txt");
  });

  it("listing a hidden directory yields nothing", async () => {
    const entries = await collectEntries(api.list("/private"));
    expect(entries).toEqual([]);
  });

  it("listing a hidden directory recursively yields nothing", async () => {
    const entries = await collectEntries(api.list("/private", { recursive: true }));
    expect(entries).toEqual([]);
  });
});

describe("FilteredFilesApi - stats / exists", () => {
  let source: MemFilesApi;
  let api: FilteredFilesApi;

  beforeEach(async () => {
    source = new MemFilesApi();
    await source.write("/visible.txt", [toBytes("v")]);
    await source.write("/private/secret.txt", [toBytes("s")]);
    api = new FilteredFilesApi(source, newPathFilter("/private"));
  });

  it("stats on visible file returns metadata", async () => {
    const s = await api.stats("/visible.txt");
    expect(s?.kind).toBe("file");
  });

  it("stats on hidden file returns undefined", async () => {
    expect(await api.stats("/private/secret.txt")).toBeUndefined();
    expect(await api.stats("/private")).toBeUndefined();
  });

  it("exists is true for visible, false for hidden", async () => {
    expect(await api.exists("/visible.txt")).toBe(true);
    expect(await api.exists("/private")).toBe(false);
    expect(await api.exists("/private/secret.txt")).toBe(false);
  });

  it("hidden path that does NOT exist underneath still returns false (not undefined)", async () => {
    expect(await api.exists("/private/missing.txt")).toBe(false);
  });
});

describe("FilteredFilesApi - remove", () => {
  let source: MemFilesApi;
  let api: FilteredFilesApi;

  beforeEach(async () => {
    source = new MemFilesApi();
    await source.write("/visible.txt", [toBytes("v")]);
    await source.write("/private/secret.txt", [toBytes("s")]);
    api = new FilteredFilesApi(source, newPathFilter("/private"));
  });

  it("removes visible files", async () => {
    expect(await api.remove("/visible.txt")).toBe(true);
    expect(await source.exists("/visible.txt")).toBe(false);
  });

  it("returns false for hidden paths and does NOT delete from source", async () => {
    expect(await api.remove("/private/secret.txt")).toBe(false);
    expect(await source.exists("/private/secret.txt")).toBe(true);
  });
});

describe("FilteredFilesApi - move", () => {
  let source: MemFilesApi;
  let api: FilteredFilesApi;

  beforeEach(async () => {
    source = new MemFilesApi();
    await source.write("/a.txt", [toBytes("a")]);
    await source.write("/private/b.txt", [toBytes("b")]);
    api = new FilteredFilesApi(source, newPathFilter("/private"));
  });

  it("moves visible to visible", async () => {
    expect(await api.move("/a.txt", "/c.txt")).toBe(true);
    expect(await source.exists("/a.txt")).toBe(false);
    expect(await readAll(source.read("/c.txt"))).toBe("a");
  });

  it("returns false when source is hidden, no changes applied", async () => {
    expect(await api.move("/private/b.txt", "/c.txt")).toBe(false);
    expect(await source.exists("/private/b.txt")).toBe(true);
    expect(await source.exists("/c.txt")).toBe(false);
  });

  it("returns false when target is hidden, no changes applied", async () => {
    expect(await api.move("/a.txt", "/private/c.txt")).toBe(false);
    expect(await source.exists("/a.txt")).toBe(true);
    expect(await source.exists("/private/c.txt")).toBe(false);
  });
});

describe("FilteredFilesApi - copy", () => {
  let source: MemFilesApi;
  let api: FilteredFilesApi;

  beforeEach(async () => {
    source = new MemFilesApi();
    await source.write("/a.txt", [toBytes("a")]);
    await source.write("/private/b.txt", [toBytes("b")]);
    api = new FilteredFilesApi(source, newPathFilter("/private"));
  });

  it("copies visible to visible", async () => {
    expect(await api.copy("/a.txt", "/c.txt")).toBe(true);
    expect(await readAll(source.read("/a.txt"))).toBe("a");
    expect(await readAll(source.read("/c.txt"))).toBe("a");
  });

  it("returns false when source is hidden, no changes applied", async () => {
    expect(await api.copy("/private/b.txt", "/c.txt")).toBe(false);
    expect(await source.exists("/c.txt")).toBe(false);
  });

  it("returns false when target is hidden, no changes applied", async () => {
    expect(await api.copy("/a.txt", "/private/c.txt")).toBe(false);
    expect(await source.exists("/private/c.txt")).toBe(false);
  });
});

describe("FilteredFilesApi - async PathFilter", () => {
  it("supports async predicates", async () => {
    const source = new MemFilesApi();
    await source.write("/visible.txt", [toBytes("v")]);
    await source.write("/private.txt", [toBytes("p")]);
    const api = new FilteredFilesApi(source, async (path) => {
      await Promise.resolve();
      return path !== "/private.txt";
    });
    expect(await api.exists("/visible.txt")).toBe(true);
    expect(await api.exists("/private.txt")).toBe(false);
    const names = (await collectEntries(api.list("/"))).map((e) => e.name);
    expect(names).toContain("visible.txt");
    expect(names).not.toContain("private.txt");
  });
});

describe("FilteredFilesApi - custom PathFilter (non-prefix)", () => {
  it("hides files by extension", async () => {
    const source = new MemFilesApi();
    await source.write("/keep.md", [toBytes("k")]);
    await source.write("/skip.log", [toBytes("s")]);
    const api = new FilteredFilesApi(source, (path) => !path.endsWith(".log"));
    const names = (await collectEntries(api.list("/"))).map((e) => e.name);
    expect(names).toContain("keep.md");
    expect(names).not.toContain("skip.log");
    expect(await api.exists("/skip.log")).toBe(false);
    expect(await api.exists("/keep.md")).toBe(true);
  });
});
