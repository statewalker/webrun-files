/**
 * The non-recursive S3 listing reorders common prefixes, and its buffer must
 * survive page boundaries. RustFS pages at 1000 keys, so the integration suite
 * never crosses one; this fake pages at two.
 */
import { ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { comparePaths } from "@statewalker/webrun-files";
import { collectGenerator } from "@statewalker/webrun-files-tests";
import { describe, expect, it } from "vitest";
import { S3FilesApi } from "../src/index.js";

/** Just enough of ListObjectsV2: Prefix, Delimiter, StartAfter, continuation, 2 items per page. */
function fakeClient(keys: string[], pageSize = 2, seen: (string | undefined)[] = []): S3Client {
  const sorted = [...keys].sort(comparePaths);
  return {
    async send(command: unknown) {
      if (!(command instanceof ListObjectsV2Command)) throw new Error("unsupported command");
      const { Prefix = "", Delimiter, StartAfter, ContinuationToken } = command.input;
      seen.push(StartAfter);
      const marker = ContinuationToken ?? StartAfter;
      const items: { key: string; prefix: boolean }[] = [];
      for (const key of sorted) {
        if (!key.startsWith(Prefix)) continue;
        const rest = key.slice(Prefix.length);
        const cut = Delimiter ? rest.indexOf(Delimiter) : -1;
        const item =
          cut === -1
            ? { key, prefix: false }
            : { key: Prefix + rest.slice(0, cut + 1), prefix: true };
        if (marker !== undefined && comparePaths(item.key, marker) <= 0) continue;
        if (items.at(-1)?.key === item.key) continue;
        items.push(item);
      }
      const page = items.slice(0, pageSize);
      const more = items.length > pageSize;
      return {
        Contents: page
          .filter((i) => !i.prefix)
          .map((i) => ({ Key: i.key, Size: 1, LastModified: new Date(1) })),
        CommonPrefixes: page.filter((i) => i.prefix).map((i) => ({ Prefix: i.key })),
        NextContinuationToken: more ? page[page.length - 1].key : undefined,
      };
    },
  } as unknown as S3Client;
}

const KEYS = [
  "t/B",
  "t/a b.txt",
  "t/a-x",
  "t/a.txt",
  "t/a/a",
  "t/a/b.txt",
  "t/a!/q",
  "t/a-y/q",
  "t/ab",
  "t/b",
  "t/b.",
  "t/b./z",
  "t/é.txt",
  "t/�.txt",
  "t/😀.txt",
  "t/😀/q",
];

const paths = async (it: AsyncIterable<{ path: string }>) =>
  (await collectGenerator(it)).map((e) => e.path);

describe("S3FilesApi listing order across pages", () => {
  it("keeps the file when a key and a common prefix share a path", async () => {
    const api = new S3FilesApi({ client: fakeClient(["t/b.", "t/b./z"], 1), bucket: "b" });
    const entries = await collectGenerator(api.list("/t"));
    expect(entries.map((e) => [e.path, e.kind])).toEqual([["/t/b.", "file"]]);
  });

  for (const pageSize of [1, 2, 3, 1000]) {
    it(`lists direct children in path order with ${pageSize} key(s) per page`, async () => {
      const api = new S3FilesApi({ client: fakeClient(KEYS, pageSize), bucket: "b" });
      const listed = await paths(api.list("/t"));
      expect(listed).toEqual(
        [
          "/t/B",
          "/t/a",
          "/t/a b.txt",
          "/t/a!",
          "/t/a-x",
          "/t/a-y",
          "/t/a.txt",
          "/t/ab",
          "/t/b",
          "/t/b.",
          "/t/é.txt",
          "/t/�.txt",
          "/t/😀",
          "/t/😀.txt",
        ].sort(comparePaths),
      );
    });

    for (const recursive of [false, true]) {
      it(`resumes after every entry and gap — ${recursive ? "recursive" : "non-recursive"}, page ${pageSize}`, async () => {
        const api = new S3FilesApi({ client: fakeClient(KEYS, pageSize), bucket: "b" });
        const full = await paths(api.list("/t", { recursive }));
        for (let i = 1; i < full.length; i++)
          expect(comparePaths(full[i - 1], full[i])).toBeLessThan(0);
        const cursors = [
          ...full,
          "/",
          "/t",
          "/t/a/",
          "/t/a!",
          "/t/a.",
          "/t/b.!",
          "/t/😀",
          "/u",
          "/s",
        ];
        // Cursors a normalising translation would move past real entries.
        cursors.push("/t/./z", "/t/a//b", "/t//😀");
        for (const after of cursors) {
          expect(await paths(api.list("/t", { recursive, after })), `after ${after}`).toEqual(
            full.filter((p) => comparePaths(p, after) > 0),
          );
        }
      });
    }
  }

  it("passes the cursor to S3 as StartAfter instead of re-listing from the start", async () => {
    const seen: (string | undefined)[] = [];
    const api = new S3FilesApi({ client: fakeClient(KEYS, 1000, seen), bucket: "b" });
    await collectGenerator(api.list("/t", { recursive: true, after: "/t/b" }));
    expect(seen).toEqual(["t/b"]);
  });

  it("respects a key prefix", async () => {
    const api = new S3FilesApi({
      client: fakeClient(
        KEYS.map((k) => `root/${k}`),
        2,
      ),
      bucket: "b",
      prefix: "root",
    });
    expect((await paths(api.list("/t", { after: "/t/a.txt" })))[0]).toBe("/t/ab");
  });
});
