/** The wire: which request each FilesApi call sends, and how answers map back. */
import { collectGenerator, collectStream, toBytes } from "@statewalker/webrun-files-tests";
import { describe, expect, it } from "vitest";
import type { FetchHandler } from "../src/index.js";
import { direct } from "./helpers.js";

interface Seen {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  status: number;
}

/** A client over a server that records every request and response status. */
async function recorded(options: Parameters<typeof direct>[0] = {}) {
  const seen: Seen[] = [];
  const setup = await direct({
    ...options,
    wrapFetch: (server) => async (req) => {
      const url = new URL(req.url);
      const res = await server(req);
      seen.push({
        method: req.method,
        path: decodeURI(url.pathname),
        search: decodeURIComponent(url.search),
        headers: Object.fromEntries(req.headers),
        status: res.status,
      });
      return res;
    },
  });
  seen.length = 0; // drop the capabilities request
  return { ...setup, seen };
}

describe("one request per call, with its own verb", () => {
  it("maps read, stats, write, mkdir, copy, move, remove and list", async () => {
    const { client, seen } = await recorded({ client: { upload: "stream" } });
    await client.write("/d/a.txt", [toBytes("hello")]);
    await collectStream(client.read("/d/a.txt"));
    await client.stats("/d/a.txt");
    await client.mkdir("/e");
    await client.copy("/d/a.txt", "/e/b.txt");
    await client.move("/e/b.txt", "/e/c.txt");
    await client.remove("/e/c.txt");
    await collectGenerator(client.list("/d", { recursive: true }));
    expect(seen.map((s) => `${s.method} ${s.path}${s.search} ${s.status}`)).toEqual([
      "PUT /api/files/d/a.txt 204",
      "GET /api/files/d/a.txt 200",
      "HEAD /api/files/d/a.txt 200",
      "MKCOL /api/files/e 204",
      "COPY /api/files/d/a.txt 204",
      "MOVE /api/files/e/b.txt 204",
      "DELETE /api/files/e/c.txt 204",
      "GET /api/files/d?list&limit=256&recursive=1 200",
    ]);
    expect(seen[4].headers.destination).toBe("http://files.test/api/files/e/b.txt");
  });

  it("uses only POST ?op= for the post verb form", async () => {
    const { client, seen } = await recorded({ client: { methods: "post" } });
    await client.write("/a", [toBytes("x")]);
    await client.mkdir("/m");
    await client.copy("/a", "/b c");
    await client.move("/b c", "/d");
    await client.remove("/d");
    const ops = seen.filter((s) => s.search.includes("op="));
    expect(ops.map((s) => `${s.method} ${s.path}${s.search}`)).toEqual([
      "POST /api/files/m?op=mkdir",
      "POST /api/files/a?op=copy&to=/b c",
      "POST /api/files/b c?op=move&to=/d",
      "POST /api/files/d?op=remove",
    ]);
    expect(seen.some((s) => ["MKCOL", "COPY", "MOVE", "DELETE"].includes(s.method))).toBe(false);
  });

  for (const [disabled, form] of [
    ["http", { methods: "http" }],
    ["post", { methods: "post" }],
  ] as const) {
    it(`answers 405 to the ${disabled} form when the server disables it`, async () => {
      const { client } = await direct({
        server: { methods: { http: disabled !== "http", post: disabled !== "post" } },
        client: form,
      });
      await expect(client.mkdir("/x")).rejects.toThrow(/disabled/);
    });
  }
});

describe("reads", () => {
  it("sends a Range header and receives 206 with exactly the range", async () => {
    const { client, seen } = await recorded();
    await client.write("/r.bin", [Uint8Array.from({ length: 100 }, (_, i) => i)]);
    seen.length = 0;
    const got = await collectStream(client.read("/r.bin", { start: 10, length: 5 }));
    expect(Array.from(got)).toEqual([10, 11, 12, 13, 14]);
    expect(seen[0].headers.range).toBe("bytes=10-14");
    expect(seen[0].status).toBe(206);
  });

  it("answers the server's own headers for a range", async () => {
    const { server } = await direct();
    const url = "http://files.test/api/files/r.bin";
    await server(new Request(url, { method: "PUT", body: new Uint8Array(100) }));
    const res = await server(new Request(url, { headers: { Range: "bytes=-10" } }));
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 90-99/100");
    expect(res.headers.get("Content-Length")).toBe("10");
    const past = await server(new Request(url, { headers: { Range: "bytes=100-" } }));
    expect(past.status).toBe(416);
    expect(past.headers.get("Content-Range")).toBe("bytes */100");
  });

  it("maps 404 for a missing file or a directory, and 416, to an empty read", async () => {
    const { client, seen } = await recorded();
    await client.write("/d/f", [toBytes("abc")]);
    seen.length = 0;
    expect((await collectStream(client.read("/missing"))).length).toBe(0);
    expect((await collectStream(client.read("/d"))).length).toBe(0);
    expect((await collectStream(client.read("/d/f", { start: 3 }))).length).toBe(0);
    expect(seen.map((s) => s.status)).toEqual([404, 404, 416]);
  });

  it("sends no request for a zero-length range", async () => {
    const { client, seen } = await recorded();
    await collectStream(client.read("/anything", { length: 0 }));
    expect(seen).toEqual([]);
  });
});

describe("stats", () => {
  it("carries kind, size and millisecond time in HEAD headers", async () => {
    const { server, fs } = await direct();
    await fs.write("/f.txt", [toBytes("12345")]);
    await fs.mkdir("/dir");
    const file = await server(new Request("http://files.test/api/files/f.txt", { method: "HEAD" }));
    expect(file.headers.get("X-File-Kind")).toBe("file");
    expect(file.headers.get("X-File-Size")).toBe("5");
    const stats = await fs.stats("/f.txt");
    expect(file.headers.get("X-Last-Modified-Ms")).toBe(
      String(stats?.kind === "file" && stats.lastModified),
    );
    const dir = await server(new Request("http://files.test/api/files/dir", { method: "HEAD" }));
    expect([dir.status, dir.headers.get("X-File-Kind"), dir.headers.has("X-File-Size")]).toEqual([
      200,
      "directory",
      false,
    ]);
  });
});

describe("listing pages", () => {
  async function tree(pageSize: number, wrap?: (f: FetchHandler) => FetchHandler) {
    const setup = await direct({ client: { pageSize }, wrapFetch: wrap });
    for (const name of ["a", "b", "c", "d", "e"])
      await setup.fs.write(`/t/${name}`, [toBytes(name)]);
    return setup;
  }

  it("fetches pages of `limit`, each after the last path of the previous one", async () => {
    const lists: string[] = [];
    const { client } = await tree(2, (server) => async (req) => {
      const url = new URL(req.url);
      if (url.searchParams.has("list")) lists.push(decodeURIComponent(url.search));
      return server(req);
    });
    const paths = (await collectGenerator(client.list("/t"))).map((e) => e.path);
    expect(paths).toEqual(["/t/a", "/t/b", "/t/c", "/t/d", "/t/e"]);
    expect(lists).toEqual([
      "?list&limit=2",
      "?list&limit=2&after=/t/b",
      "?list&limit=2&after=/t/d",
    ]);
  });

  it("answers next only for a full page, and caps limit at maxPageSize", async () => {
    const { server, fs } = await direct({ server: { maxPageSize: 3 } });
    for (const name of ["a", "b", "c", "d"]) await fs.write(`/t/${name}`, [toBytes(name)]);
    const page = async (q: string) =>
      (await server(new Request(`http://files.test/api/files/t?list&${q}`))).json();
    expect(await page("limit=100")).toEqual({
      items: expect.any(Array),
      next: "/t/c",
    });
    expect(await page("limit=100&after=/t/c")).toEqual({
      items: [expect.objectContaining({ path: "/t/d" })],
    });
    expect(
      await (await server(new Request("http://files.test/api/files/none?list"))).json(),
    ).toEqual({
      items: [],
    });
  });

  it("fetches the next page only when the consumer has taken the current one", async () => {
    let requests = 0;
    const { client } = await tree(2, (server) => async (req) => {
      if (new URL(req.url).searchParams.has("list")) requests++;
      return server(req);
    });
    const it = client.list("/t")[Symbol.asyncIterator]();
    await it.next();
    await it.next();
    expect(requests).toBe(1);
    await it.next();
    expect(requests).toBe(2);
  });

  it("retries a failed page after the last entry yielded, yielding each entry once", async () => {
    let calls = 0;
    const { client } = await tree(2, (server) => async (req) => {
      if (new URL(req.url).searchParams.has("list") && ++calls === 2)
        throw new TypeError("network down");
      return server(req);
    });
    const paths = (await collectGenerator(client.list("/t"))).map((e) => e.path);
    expect(paths).toEqual(["/t/a", "/t/b", "/t/c", "/t/d", "/t/e"]);
  });

  it("gives up after `retries` failures", async () => {
    const { client } = await tree(2, (server) => async (req) => {
      if (new URL(req.url).searchParams.has("list")) throw new TypeError("network down");
      return server(req);
    });
    await expect(collectGenerator(client.list("/t"))).rejects.toThrow("network down");
  });
});

describe("errors", () => {
  it("rethrows the served file system's error with its message and name", async () => {
    const { MemFilesApi } = await import("@statewalker/webrun-files-mem");
    const fs = new MemFilesApi();
    fs.mkdir = async () => {
      const error = new Error("disk is read-only");
      error.name = "ReadOnlyError";
      throw error;
    };
    const { client } = await direct({ fs });
    await expect(client.mkdir("/x")).rejects.toMatchObject({
      name: "ReadOnlyError",
      message: "disk is read-only",
    });
  });

  it("answers capabilities", async () => {
    const { server } = await direct({ server: { minPartSize: 11, maxPageSize: 12 } });
    const res = await server(new Request("http://files.test/api/files/?capabilities"));
    expect(await res.json()).toEqual({
      version: 1,
      minPartSize: 11,
      maxPartSize: 64 * 1024 * 1024,
      maxParts: 10_000,
      maxPageSize: 12,
      methods: { http: true, post: true },
    });
  });
});
