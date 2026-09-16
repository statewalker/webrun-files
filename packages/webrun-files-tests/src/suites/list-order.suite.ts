/**
 * Ordered listings and `ListOptions.after`, for every FilesApi.
 *
 * `list()` must yield paths in strictly increasing code-point order
 * (`comparePaths`), recursively or not, and `after` must yield exactly the
 * suffix of the listing that follows a path — which need not exist.
 *
 * The fixture is built to catch each way an implementation gets this wrong:
 * `-`, `.` and ` ` sort before `/`, so `a-x`, `a.txt` and `a b.txt` fall
 * between the directory `a` and its children in a recursive listing; `B`
 * sorts before `a`; and `😀` (a surrogate pair) sorts after `�` by code
 * point although JavaScript's `<` says otherwise.
 */

import { comparePaths, type FileInfo } from "@statewalker/webrun-files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectGenerator, toBytes } from "../test-utils.js";
import type { FilesApiFactory, FilesApiTestContext } from "./files-api.suite.js";

const ROOT = "/order";
const FILES = [
  "B",
  "a b.txt",
  "a-x",
  "a.txt",
  "a/b.txt",
  "a/c/d.txt",
  "b",
  "é.txt",
  "�.txt",
  "😀.txt",
].map((name) => `${ROOT}/${name}`);

/** The direct children of ROOT, directories included, in the required order. */
const DIRECT = ["B", "a", "a b.txt", "a-x", "a.txt", "b", "é.txt", "�.txt", "😀.txt"].map(
  (name) => `${ROOT}/${name}`,
);

const paths = (entries: FileInfo[]) => entries.map((e) => e.path);

function expectStrictlyIncreasing(list: string[]) {
  for (let i = 1; i < list.length; i++) {
    expect(comparePaths(list[i - 1], list[i]), `${list[i - 1]} before ${list[i]}`).toBeLessThan(0);
  }
}

/** Cursors that are not entries: between entries, before the directory, after everything. */
const MISSING_CURSORS = [
  "/",
  "/ordeq",
  ROOT,
  `${ROOT}/A`,
  `${ROOT}/a!`,
  `${ROOT}/a/`,
  `${ROOT}/a/bb`,
  `${ROOT}/a/c/`,
  `${ROOT}/c`,
  `${ROOT}/😀.txu`,
  // Not normalised on purpose: "/order/./z" sorts before every entry, although
  // normalising it gives "/order/z", which sorts after most of them.
  `${ROOT}/./z`,
  `${ROOT}/a//b`,
  "/orderz",
  "/z",
];

export function createListOrderTests(name: string, factory: FilesApiFactory): void {
  describe(`list() order and after [${name}]`, () => {
    let ctx: FilesApiTestContext;

    beforeEach(async () => {
      ctx = await factory();
      for (const path of FILES) await ctx.api.write(path, [toBytes(path)]);
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    it("lists direct children in code-point path order, directories included", async () => {
      expect(paths(await collectGenerator(ctx.api.list(ROOT)))).toEqual(DIRECT);
    });

    it("lists recursively in strictly increasing path order, with every file in place", async () => {
      const all = paths(await collectGenerator(ctx.api.list(ROOT, { recursive: true })));
      expectStrictlyIncreasing(all);
      // Which directories a recursive listing includes varies by backend; files do not.
      const files = all.filter((p) => FILES.includes(p));
      expect(files).toEqual(FILES);
    });

    for (const recursive of [false, true]) {
      const mode = recursive ? "recursive" : "non-recursive";

      it(`${mode}: after each entry yields exactly the rest`, async () => {
        const full = paths(await collectGenerator(ctx.api.list(ROOT, { recursive })));
        for (let i = 0; i < full.length; i++) {
          const rest = paths(
            await collectGenerator(ctx.api.list(ROOT, { recursive, after: full[i] })),
          );
          expect(rest, `after ${full[i]}`).toEqual(full.slice(i + 1));
        }
      });

      it(`${mode}: after a path that does not exist yields the entries that follow it`, async () => {
        const full = paths(await collectGenerator(ctx.api.list(ROOT, { recursive })));
        for (const after of MISSING_CURSORS) {
          const rest = paths(await collectGenerator(ctx.api.list(ROOT, { recursive, after })));
          expect(rest, `after ${after}`).toEqual(full.filter((p) => comparePaths(p, after) > 0));
        }
      });
    }

    it("resumes a listing page by page to exactly the full listing", async () => {
      const full = paths(await collectGenerator(ctx.api.list(ROOT, { recursive: true })));
      const pages: string[] = [];
      let after: string | undefined;
      // Bounded, so an implementation that ignores `after` fails instead of looping forever.
      for (let request = 0; request <= full.length; request++) {
        const page: string[] = [];
        for await (const entry of ctx.api.list(ROOT, { recursive: true, after })) {
          page.push(entry.path);
          if (page.length === 3) break;
        }
        if (page.length === 0) break;
        pages.push(...page);
        after = page[page.length - 1];
      }
      expect(pages).toEqual(full);
    });

    it("lists the root in order too", async () => {
      const root = paths(await collectGenerator(ctx.api.list("/")));
      expectStrictlyIncreasing(root);
      expect(root).toContain(ROOT);
    });
  });
}
