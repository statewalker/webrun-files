/**
 * SQLAR stores symlinks as sz = -1 with the target as TEXT. FileKind has no
 * word for them, so the FilesApi view follows them like POSIX stat(), and
 * symlink()/readlink() expose the link itself.
 */
import { collectGenerator, collectStream } from "@statewalker/webrun-files-tests";
import { describe, expect, it } from "vitest";
import { newArchive, rawRow } from "./helpers.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const text = async (files: { read: (p: string) => AsyncIterable<Uint8Array> }, p: string) =>
  dec.decode(await collectStream(files.read(p)));

describe("symlink rows", () => {
  it("stores sz=-1, the target as TEXT, and the symlink mode", async () => {
    const { db, files } = await newArchive();
    await files.symlink("/pkg/latest.js", "./index.js");
    const row = rawRow(db, "pkg/latest.js");
    expect(row?.sz).toBe(-1);
    expect(row?.dtype).toBe("text");
    expect(row?.data).toBe("./index.js");
    expect(row?.mode).toBe(0o120777);
    expect(rawRow(db, "pkg")?.dtype).toBe("null");
  });

  it("reads the stored target back with readlink", async () => {
    const { files } = await newArchive();
    await files.symlink("/l", "../somewhere/else");
    await files.write("/f.txt", [enc.encode("x")]);
    expect(await files.readlink("/l")).toBe("../somewhere/else");
    expect(await files.readlink("/f.txt")).toBeUndefined();
    expect(await files.readlink("/missing")).toBeUndefined();
  });
});

describe("following links", () => {
  it("follows a relative link to a file for stats, exists and read", async () => {
    const { files } = await newArchive();
    await files.write("/pkg/index.js", [enc.encode("export {}")]);
    await files.symlink("/pkg/latest.js", "./index.js");
    expect(await files.stats("/pkg/latest.js")).toEqual(await files.stats("/pkg/index.js"));
    expect(await files.exists("/pkg/latest.js")).toBe(true);
    expect(await text(files, "/pkg/latest.js")).toBe("export {}");
  });

  it("follows an absolute target from the root", async () => {
    const { files } = await newArchive();
    await files.write("/data/a.txt", [enc.encode("abs")]);
    await files.symlink("/links/a", "/data/a.txt");
    expect(await text(files, "/links/a")).toBe("abs");
  });

  it("collapses .. in a target against the link's parent", async () => {
    const { files } = await newArchive();
    await files.write("/a/c.txt", [enc.encode("up")]);
    await files.symlink("/a/b/l", "../c.txt");
    expect(await text(files, "/a/b/l")).toBe("up");
  });

  it("follows a chain of links", async () => {
    const { files } = await newArchive();
    await files.write("/t.txt", [enc.encode("end")]);
    await files.symlink("/l1", "l2");
    await files.symlink("/l2", "t.txt");
    expect(await text(files, "/l1")).toBe("end");
  });

  it("follows a link to a directory for stats and list, with paths under the link", async () => {
    const { files } = await newArchive();
    await files.write("/real/x.txt", [enc.encode("x")]);
    await files.symlink("/alias", "real");
    expect(await files.stats("/alias")).toEqual({ kind: "directory" });
    const entries = await collectGenerator(files.list("/alias"));
    expect(entries.map((e) => [e.kind, e.path])).toEqual([["file", "/alias/x.txt"]]);
  });
});

describe("unresolvable links behave as missing paths", () => {
  it("treats a dangling link as missing", async () => {
    const { files } = await newArchive();
    await files.symlink("/dangling", "nowhere");
    expect(await files.stats("/dangling")).toBeUndefined();
    expect(await files.exists("/dangling")).toBe(false);
    expect(await collectStream(files.read("/dangling"))).toHaveLength(0);
  });

  it("treats a cycle as missing, without throwing", async () => {
    const { files } = await newArchive();
    await files.symlink("/a", "b");
    await files.symlink("/b", "a");
    expect(await files.stats("/a")).toBeUndefined();
    expect(await collectStream(files.read("/a"))).toHaveLength(0);
  });

  it("follows at most 8 links", async () => {
    const { files } = await newArchive();
    await files.write("/t.txt", [enc.encode("x")]);
    // /l1 → /l2 → … → /lN → /t.txt: N links followed.
    const chain = async (n: number, prefix: string) => {
      for (let i = 1; i <= n; i++) {
        await files.symlink(`/${prefix}${i}`, i === n ? "t.txt" : `${prefix}${i + 1}`);
      }
    };
    await chain(8, "ok");
    await chain(9, "long");
    expect(await files.exists("/ok1")).toBe(true);
    expect(await files.exists("/long1")).toBe(false);
  });
});

describe("links in listings", () => {
  async function tree() {
    const { db, files } = await newArchive();
    await files.write("/dir/sub/deep.txt", [enc.encode("deep")]);
    await files.write("/dir/file.txt", [enc.encode("12345")]);
    await files.symlink("/dir/to-file", "file.txt");
    await files.symlink("/dir/to-sub", "sub");
    await files.symlink("/dir/to-parent", "..");
    await files.symlink("/dir/dangling", "nowhere");
    return { db, files };
  }

  it("reports each link as its target's kind, size and time, under the link's path", async () => {
    const { files } = await tree();
    const entries = await collectGenerator(files.list("/dir"));
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName["to-file"]).toEqual({
      ...(await files.stats("/dir/file.txt")),
      name: "to-file",
      path: "/dir/to-file",
    });
    expect(byName["to-sub"]).toEqual({ kind: "directory", name: "to-sub", path: "/dir/to-sub" });
    expect(byName["to-parent"]).toEqual({
      kind: "directory",
      name: "to-parent",
      path: "/dir/to-parent",
    });
  });

  it("omits unresolvable links", async () => {
    const { files } = await tree();
    const names = (await collectGenerator(files.list("/dir"))).map((e) => e.name);
    expect(names).not.toContain("dangling");
  });

  it("does not descend through a link to a directory when recursive", async () => {
    const { files } = await tree();
    const paths = (await collectGenerator(files.list("/", { recursive: true }))).map((e) => e.path);
    expect(paths.sort()).toEqual(
      [
        "/dir",
        "/dir/file.txt",
        "/dir/sub",
        "/dir/sub/deep.txt",
        "/dir/to-file",
        "/dir/to-parent",
        "/dir/to-sub",
      ].sort(),
    );
  });

  it("agrees with stats on every entry", async () => {
    const { files } = await tree();
    for (const entry of await collectGenerator(files.list("/", { recursive: true }))) {
      const { name: _name, path, ...stats } = entry;
      expect(await files.stats(path), path).toEqual(stats);
    }
  });
});

describe("mutations act on the link itself", () => {
  it("remove deletes the link and keeps the target", async () => {
    const { files } = await newArchive();
    await files.write("/t.txt", [enc.encode("x")]);
    await files.symlink("/l", "t.txt");
    expect(await files.remove("/l")).toBe(true);
    expect(await files.readlink("/l")).toBeUndefined();
    expect(await files.exists("/t.txt")).toBe(true);
  });

  it("remove deletes a dangling link", async () => {
    const { files } = await newArchive();
    await files.symlink("/l", "nowhere");
    expect(await files.remove("/l")).toBe(true);
    expect(await files.readlink("/l")).toBeUndefined();
  });

  it("copy and move carry the link, not the target's content", async () => {
    const { db, files } = await newArchive();
    await files.write("/t.txt", [enc.encode("x")]);
    await files.symlink("/l", "t.txt");
    await files.copy("/l", "/copy");
    await files.move("/l", "/moved");
    expect(await files.readlink("/copy")).toBe("t.txt");
    expect(await files.readlink("/moved")).toBe("t.txt");
    expect(rawRow(db, "copy")?.dtype).toBe("text");
    expect(await files.readlink("/l")).toBeUndefined();
  });
});
