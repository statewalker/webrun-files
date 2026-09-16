import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { collectGenerator, collectStream, positionContent } from "@statewalker/webrun-files-tests";
import { describe, expect, it } from "vitest";
import { direct } from "./helpers.js";

describe("chunked upload limits, client side", () => {
  it("stops with a clear error before exceeding the server's part count, and aborts", async () => {
    const requests: string[] = [];
    const { fs, client } = await direct({
      server: { minPartSize: 10, maxParts: 3 },
      client: { upload: "chunked", partSize: 10 },
      wrapFetch: (server) => async (req) => {
        requests.push(`${req.method} ${new URL(req.url).search}`);
        return server(req);
      },
    });
    await expect(client.write("/big.bin", positionContent(45, [7]))).rejects.toThrow(
      /more than 3 parts of 10 bytes/,
    );
    expect(requests.some((r) => r.includes("part=4"))).toBe(false);
    expect(requests.at(-1)).toMatch(/^DELETE \?upload=/);
    expect(await fs.exists("/big.bin")).toBe(false);
  });
});

const URL_OF = (path: string, query = "") => `http://files.test/api/files${path}${query}`;

async function stagingFiles(staging: MemFilesApi) {
  return (await collectGenerator(staging.list("/", { recursive: true })))
    .filter((e) => e.kind === "file")
    .map((e) => e.path);
}

describe("chunked uploads, server side", () => {
  async function setup(server: Record<string, unknown> = {}) {
    const staging = new MemFilesApi();
    const fs = new MemFilesApi();
    const { newServerStub } = await import("../src/index.js");
    const handler = newServerStub({
      fs,
      staging,
      basePath: "/api/files",
      minPartSize: 4,
      ...server,
    });
    const open = async (path: string) => {
      const res = await handler(new Request(URL_OF(path, "?uploads"), { method: "POST" }));
      expect(res.status).toBe(201);
      return ((await res.json()) as { uploadId: string }).uploadId;
    };
    const part = (path: string, id: string, n: number | string, body: BodyInit) =>
      handler(new Request(URL_OF(path, `?upload=${id}&part=${n}`), { method: "PUT", body }));
    const complete = (path: string, id: string, count: number) =>
      handler(new Request(URL_OF(path, `?upload=${id}&complete=${count}`), { method: "POST" }));
    return { staging, fs, handler, open, part, complete };
  }

  it("stages parts as {dd}/{uuid}-{nnnnnn}.bin beside {dd}/{uuid}.json, and cleans up on completion", async () => {
    const { staging, fs, open, part, complete } = await setup();
    const id = await open("/out.txt");
    expect((await part("/out.txt", id, 1, "abcd")).status).toBe(204);
    expect((await part("/out.txt", id, 2, "ef")).status).toBe(204);
    const dd = id.slice(0, 2);
    expect(await stagingFiles(staging)).toEqual([
      `/${dd}/${id}-000001.bin`,
      `/${dd}/${id}-000002.bin`,
      `/${dd}/${id}.json`,
    ]);
    expect(await fs.exists("/out.txt")).toBe(false);
    expect((await complete("/out.txt", id, 2)).status).toBe(204);
    expect(new TextDecoder().decode(await collectStream(fs.read("/out.txt")))).toBe("abcdef");
    expect(await stagingFiles(staging)).toEqual([]);
  });

  it("lets a retried part overwrite the first attempt", async () => {
    const { fs, open, part, complete } = await setup();
    const id = await open("/f");
    await part("/f", id, 1, "XXXX");
    await part("/f", id, 1, "abcd");
    await part("/f", id, 2, "e");
    await complete("/f", id, 2);
    expect(new TextDecoder().decode(await collectStream(fs.read("/f")))).toBe("abcde");
  });

  it("refuses a part before the last that is smaller than minPartSize", async () => {
    const { open, part, complete } = await setup();
    const id = await open("/f");
    await part("/f", id, 1, "abc");
    await part("/f", id, 2, "d");
    const res = await complete("/f", id, 2);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
      /Part 1 holds 3 bytes/,
    );
  });

  it("refuses to complete with a missing part", async () => {
    const { open, part, complete } = await setup();
    const id = await open("/f");
    await part("/f", id, 2, "abcd");
    expect((await complete("/f", id, 2)).status).toBe(400);
  });

  it("answers 413 for a part over maxPartSize, keeping nothing of it", async () => {
    const { staging, open, part } = await setup({ maxPartSize: 8 });
    const id = await open("/f");
    expect((await part("/f", id, 1, "123456789")).status).toBe(413);
    expect((await stagingFiles(staging)).filter((p) => p.endsWith(".bin"))).toEqual([]);
  });

  it("answers 409 when an upload is used for another path: an id grants only its own path", async () => {
    const { fs, open, part, complete } = await setup();
    const id = await open("/mine");
    expect((await part("/other", id, 1, "abcd")).status).toBe(409);
    await part("/mine", id, 1, "abcd");
    expect((await complete("/other", id, 1)).status).toBe(409);
    expect(await fs.exists("/other")).toBe(false);
  });

  it("answers 400 for a malformed id or part number, 404 for an unknown upload", async () => {
    const { open, part } = await setup({ maxParts: 5 });
    const id = await open("/f");
    expect((await part("/f", "../../etc", 1, "a")).status).toBe(400);
    expect((await part("/f", id, 0, "a")).status).toBe(400);
    expect((await part("/f", id, 6, "a")).status).toBe(400);
    expect((await part("/f", id, "1.5", "a")).status).toBe(400);
    expect((await part("/f", "00000000-0000-4000-8000-000000000000", 1, "a")).status).toBe(404);
  });

  it("deletes parts and metadata on abort", async () => {
    const { staging, handler, open, part } = await setup();
    const id = await open("/f");
    await part("/f", id, 1, "abcd");
    const res = await handler(new Request(URL_OF("/f", `?upload=${id}`), { method: "DELETE" }));
    expect(res.status).toBe(204);
    expect(await stagingFiles(staging)).toEqual([]);
  });

  it("discards staged parts even when writing the target fails", async () => {
    const { staging, fs, open, part, complete } = await setup();
    fs.write = async () => {
      throw new Error("target full");
    };
    const id = await open("/f");
    await part("/f", id, 1, "abcd");
    expect((await complete("/f", id, 1)).status).toBe(500);
    expect(await stagingFiles(staging)).toEqual([]);
  });

  it("sweeps uploads older than the threshold and orphan parts, keeping fresh ones", async () => {
    const { staging, handler, open, part } = await setup();
    const old = await open("/old");
    await part("/old", old, 1, "abcd");
    const fresh = await open("/fresh");
    await part("/fresh", fresh, 1, "abcd");
    // Age the first upload, and leave an orphan part with no metadata at all.
    const oldMeta = `/${old.slice(0, 2)}/${old}.json`;
    await staging.write(oldMeta, [
      new TextEncoder().encode(JSON.stringify({ path: "/old", created: 0 })),
    ]);
    const orphan = "11111111-1111-4111-8111-111111111111";
    await staging.write(`/11/${orphan}-000001.bin`, [new Uint8Array(4)]);
    await new Promise((r) => setTimeout(r, 20));

    expect(await handler.sweepUploads({ olderThan: 10_000 })).toBe(1);
    expect((await stagingFiles(staging)).some((p) => p.includes(old))).toBe(false);
    expect((await stagingFiles(staging)).some((p) => p.includes(fresh))).toBe(true);
    expect((await stagingFiles(staging)).some((p) => p.includes(orphan))).toBe(true); // too young
    await handler.sweepUploads({ olderThan: 1 });
    expect(await stagingFiles(staging)).toEqual([]);
  });
});

describe("chunked uploads, client side", () => {
  it("sends content that fits in one part as a single plain PUT", async () => {
    const requests: string[] = [];
    const { client } = await direct({
      server: { minPartSize: 10 },
      client: { upload: "chunked", partSize: 10 },
      wrapFetch: (server) => async (req) => {
        requests.push(`${req.method} ${new URL(req.url).search}`);
        return server(req);
      },
    });
    requests.length = 0;
    await client.write("/small", positionContent(10, [3]));
    expect(requests).toEqual(["PUT "]);
  });

  it("opens, sends full parts as they fill, and completes", async () => {
    const requests: string[] = [];
    const { fs, client } = await direct({
      server: { minPartSize: 10 },
      client: { upload: "chunked", partSize: 10 },
      wrapFetch: (server) => async (req) => {
        const url = new URL(req.url);
        requests.push(`${req.method} ${url.search.replace(/upload=[^&]+/, "upload=ID")}`);
        return server(req);
      },
    });
    requests.length = 0;
    await client.write("/big", positionContent(25, [4]));
    expect(requests).toEqual([
      "POST ?uploads",
      "PUT ?upload=ID&part=1",
      "PUT ?upload=ID&part=2",
      "PUT ?upload=ID&part=3",
      "POST ?upload=ID&complete=3",
    ]);
    expect(await collectStream(fs.read("/big"))).toEqual(await collectStream(positionContent(25)));
  });

  it("retries a failed part with the same number", async () => {
    let failed = false;
    const { fs, client } = await direct({
      server: { minPartSize: 10 },
      client: { upload: "chunked", partSize: 10 },
      wrapFetch: (server) => async (req) => {
        if (!failed && new URL(req.url).searchParams.get("part") === "2") {
          failed = true;
          throw new TypeError("connection reset");
        }
        return server(req);
      },
    });
    await client.write("/big", positionContent(25, [4]));
    expect(await collectStream(fs.read("/big"))).toEqual(await collectStream(positionContent(25)));
  });

  it("aborts the upload and leaves the target untouched when the source fails", async () => {
    const staging = new MemFilesApi();
    const { fs, client } = await direct({
      server: { minPartSize: 10, staging },
      client: { upload: "chunked", partSize: 10 },
    });
    await fs.write("/target", [new TextEncoder().encode("previous")]);
    async function* failing() {
      yield* positionContent(25, [4]);
      throw new Error("source broke");
    }
    await expect(client.write("/target", failing())).rejects.toThrow("source broke");
    expect(new TextDecoder().decode(await collectStream(fs.read("/target")))).toBe("previous");
    expect(await stagingFiles(staging)).toEqual([]);
  });

  it("holds at most one part: pulls the source only as parts are sent", async () => {
    let pulled = 0;
    let worst = 0;
    let stored = 0;
    const { client } = await direct({
      server: { minPartSize: 100 },
      client: { upload: "chunked", partSize: 100 },
      wrapFetch: (server) => async (req) => {
        if (req.method === "PUT") {
          worst = Math.max(worst, pulled - stored);
          stored += (await req.clone().arrayBuffer()).byteLength;
        }
        return server(req);
      },
    });
    async function* source() {
      for await (const chunk of positionContent(10_000, [7])) {
        pulled += chunk.length;
        yield chunk;
      }
    }
    await client.write("/f", source());
    expect(pulled).toBe(10_000);
    // One full part in hand, plus at most one source chunk read ahead to learn whether more follows.
    expect(worst).toBeLessThanOrEqual(100 + 7);
  });
});
