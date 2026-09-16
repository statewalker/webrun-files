/**
 * Ordered listings across mounts: the shared suite mounts nothing inside the
 * directory it lists, so the merge of backends and the translation of `after`
 * into each backend's namespace are checked here.
 */
import { comparePaths, type FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { collectGenerator, toBytes } from "@statewalker/webrun-files-tests";
import { describe, expect, it } from "vitest";
import { CompositeFilesApi } from "../src/index.js";

async function build() {
  const root = new MemFilesApi();
  const mountA = new MemFilesApi();
  const nested = new MemFilesApi();
  const put = async (api: FilesApi, path: string) => api.write(path, [toBytes(path)]);
  // Root backend, remapped under /base. "/t/a" in the root is shadowed by the mount.
  for (const p of [
    "/base/t/B",
    "/base/t/a-x",
    "/base/t/a.txt",
    "/base/t/a/shadowed",
    "/base/t/b/z",
    "/base/t/😀",
  ]) {
    await put(root, p);
  }
  // Mounted at /t/a from /inner; its own "c" is shadowed by the nested mount.
  for (const p of ["/inner/x.txt", "/inner/c-y", "/inner/c/shadowed", "/inner/d/e"])
    await put(mountA, p);
  for (const p of ["/m1", "/sub/m2"]) await put(nested, p);

  const fs = new CompositeFilesApi(root, "/base")
    .mount("/t/a", mountA, "/inner")
    .mount("/t/a/c", nested);
  return fs;
}

const RECURSIVE = [
  "/t/B",
  "/t/a",
  "/t/a-x",
  "/t/a.txt",
  "/t/a/c",
  "/t/a/c-y",
  "/t/a/c/m1",
  "/t/a/c/sub",
  "/t/a/c/sub/m2",
  "/t/a/d",
  "/t/a/d/e",
  "/t/a/x.txt",
  "/t/b",
  "/t/b/z",
  "/t/😀",
];

const paths = async (it: AsyncIterable<{ path: string }>) =>
  (await collectGenerator(it)).map((e) => e.path);

describe("CompositeFilesApi ordered listings across mounts", () => {
  it("merges the root, a mount and a nested mount into one path order", async () => {
    const fs = await build();
    expect(await paths(fs.list("/t", { recursive: true }))).toEqual(RECURSIVE);
  });

  it("lists direct children with mount points as directories, in order", async () => {
    const fs = await build();
    expect(await paths(fs.list("/t"))).toEqual([
      "/t/B",
      "/t/a",
      "/t/a-x",
      "/t/a.txt",
      "/t/b",
      "/t/😀",
    ]);
    expect(await paths(fs.list("/t/a"))).toEqual(["/t/a/c", "/t/a/c-y", "/t/a/d", "/t/a/x.txt"]);
  });

  it("reports a mount point as a directory even where the root backend has an entry", async () => {
    const fs = await build();
    const entry = (await collectGenerator(fs.list("/t"))).find((e) => e.path === "/t/a");
    expect(entry).toEqual({ kind: "directory", name: "a", path: "/t/a" });
  });

  for (const recursive of [true, false]) {
    it(`resumes after every entry and every gap — ${recursive ? "recursive" : "non-recursive"}`, async () => {
      const fs = await build();
      const full = await paths(fs.list("/t", { recursive }));
      const cursors = [
        ...full,
        "/",
        "/s",
        "/t",
        "/t/a/",
        "/t/a!",
        "/t/a/c/",
        "/t/a/c/sub/",
        "/t/a/c0",
        "/t/a/zz",
        "/t/a0",
        "/u",
      ];
      for (const after of cursors) {
        expect(await paths(fs.list("/t", { recursive, after })), `after ${after}`).toEqual(
          full.filter((p) => comparePaths(p, after) > 0),
        );
      }
    });
  }

  it("lists inside a mount, resuming across its nested mount", async () => {
    const fs = await build();
    const inside = RECURSIVE.filter((p) => p.startsWith("/t/a/"));
    expect(await paths(fs.list("/t/a", { recursive: true }))).toEqual(inside);
    expect(await paths(fs.list("/t/a", { recursive: true, after: "/t/a/c/m1" }))).toEqual(
      inside.filter((p) => comparePaths(p, "/t/a/c/m1") > 0),
    );
  });

  it("does not list a mount whose whole subtree lies before the cursor", async () => {
    const fs = await build();
    const listed: string[] = [];
    const spy = (api: FilesApi, label: string): FilesApi =>
      new Proxy(api, {
        get(target, prop, receiver) {
          if (prop === "list") {
            return (p: string, o: unknown) => {
              listed.push(label);
              return target.list(p, o as never);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    const root = new MemFilesApi();
    const mounted = new MemFilesApi();
    await mounted.write("/x", [toBytes("x")]);
    await root.write("/z", [toBytes("z")]);
    const composite = new CompositeFilesApi(spy(root, "root")).mount("/a", spy(mounted, "mount"));
    expect(await paths(composite.list("/", { recursive: true, after: "/b" }))).toEqual(["/z"]);
    expect(listed).toEqual(["root"]);
    void fs;
  });
});
