import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { collectGenerator, collectStream, toBytes } from "@statewalker/webrun-files-tests";
import { describe, expect, it } from "vitest";
import { newServerStub } from "../src/index.js";
import { direct } from "./helpers.js";

describe("paths", () => {
  it("round-trips names with spaces, %, #, ?, +, & and non-ASCII", async () => {
    const { fs, client } = await direct();
    const names = [
      "a b",
      "100%",
      "#hash",
      "what?",
      "1+1",
      "a&b=c",
      "é😀",
      "semi;colon",
      "quote'\"",
    ];
    for (const name of names) {
      await client.write(`/odd/${name}`, [toBytes(name)]);
      expect(await fs.exists(`/odd/${name}`), name).toBe(true);
      expect(new TextDecoder().decode(await collectStream(client.read(`/odd/${name}`)))).toBe(name);
    }
    const listed = (await collectGenerator(client.list("/odd"))).map((e) => e.name).sort();
    expect(listed).toEqual([...names].sort());
    expect(await client.copy("/odd/a b", "/odd/#copy?")).toBe(true);
    expect(await fs.exists("/odd/#copy?")).toBe(true);
  });

  it("refuses a .. segment in the client before sending anything", async () => {
    const requests: string[] = [];
    const { client } = await direct({
      wrapFetch: (server) => async (req) => {
        requests.push(req.url);
        return server(req);
      },
    });
    requests.length = 0;
    await expect(client.write("/a/../../etc/passwd", [toBytes("x")])).rejects.toThrow(/\.\./);
    expect(requests).toEqual([]);
  });

  it("answers 400 for an encoded / segment, and 404 outside the base path", async () => {
    const fs = new MemFilesApi();
    const server = newServerStub({ fs, basePath: "/api/files" });
    const status = async (url: string) =>
      (await server(new Request(url, { method: "HEAD" }))).status;
    expect(await status("http://files.test/api/files/a%2Fb")).toBe(400);
    expect(await status("http://files.test/api/other/x")).toBe(404);
    expect(await status("http://files.test/api/filesx/x")).toBe(404);
    // The URL parser resolves %2E%2E as "..", so this arrives as /api/secret: outside the base.
    expect(await status("http://files.test/api/files/%2E%2E/secret")).toBe(404);
  });

  it("refuses . and .. segments even in a path the URL parser did not resolve", async () => {
    const { decodeFilesPath } = await import("../src/paths.js");
    expect(() => decodeFilesPath("/api/files/a/%2E%2E/b", "/api/files")).toThrow(
      /Invalid path segment/,
    );
    expect(() => decodeFilesPath("/api/files/./b", "/api/files")).toThrow(/Invalid path segment/);
    expect(() => decodeFilesPath("/api/files/%E0%A4%A", "/api/files")).toThrow(/Malformed/);
    expect(decodeFilesPath("/api/files/a%20b/%F0%9F%98%80", "/api/files")).toBe("/a b/😀");
    expect(decodeFilesPath("/api/files", "/api/files")).toBe("/");
  });
});

describe("hooks", () => {
  it("onRequest ends a request before the file system is touched", async () => {
    const fs = new MemFilesApi();
    let touched = false;
    const guarded = new Proxy(fs, {
      get(target, prop, receiver) {
        touched = true;
        return Reflect.get(target, prop, receiver);
      },
    });
    const server = newServerStub({
      fs: guarded,
      basePath: "/api/files",
      onRequest: (req) =>
        req.headers.get("Authorization") === "Bearer ok"
          ? undefined
          : new Response("no", { status: 401 }),
    });
    const res = await server(
      new Request("http://files.test/api/files/x", { method: "PUT", body: "data" }),
    );
    expect(res.status).toBe(401);
    expect(touched).toBe(false);
  });

  it("onResponse decorates successes and errors alike", async () => {
    const server = newServerStub({
      fs: new MemFilesApi(),
      basePath: "/api/files",
      onResponse: (_req, res) => {
        const headers = new Headers(res.headers);
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(res.body, { status: res.status, headers });
      },
    });
    const ok = await server(new Request("http://files.test/api/files/?capabilities"));
    const missing = await server(
      new Request("http://files.test/api/files/none", { method: "DELETE" }),
    );
    const bad = await server(new Request("http://files.test/api/files/a%2Fb", { method: "HEAD" }));
    expect([ok.status, missing.status, bad.status]).toEqual([200, 404, 400]);
    for (const res of [ok, missing, bad])
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("answers OPTIONS with 204 unless onRequest handles it", async () => {
    const server = newServerStub({ fs: new MemFilesApi(), basePath: "/api/files" });
    expect(
      (await server(new Request("http://files.test/api/files/x", { method: "OPTIONS" }))).status,
    ).toBe(204);
  });

  it("chooses the file system per request", async () => {
    const tenants = { alice: new MemFilesApi(), bob: new MemFilesApi() };
    const server = newServerStub({
      basePath: "/api/files",
      fs: (req) => tenants[req.headers.get("X-Tenant") as keyof typeof tenants],
    });
    const { newClientStub } = await import("../src/index.js");
    const as = (tenant: string) =>
      newClientStub({
        baseUrl: "http://files.test/api/files",
        fetch: server,
        setHeaders: (req) => {
          const headers = new Headers(req.headers);
          headers.set("X-Tenant", tenant);
          return new Request(req, { headers });
        },
      });
    await (await as("alice")).write("/note", [toBytes("alice's")]);
    expect(await tenants.alice.exists("/note")).toBe(true);
    expect(await tenants.bob.exists("/note")).toBe(false);
    expect(await (await as("bob")).exists("/note")).toBe(false);
  });

  it("applies setHeaders to streamed uploads too", async () => {
    const seen: (string | null)[] = [];
    const { client } = await direct({
      client: {
        upload: "stream",
        setHeaders: (req) => {
          const headers = new Headers(req.headers);
          headers.set("X-Signed", "yes");
          return new Request(req, { headers, duplex: "half" } as RequestInit);
        },
      },
      wrapFetch: (server) => async (req) => {
        seen.push(req.headers.get("X-Signed"));
        return server(req);
      },
    });
    await client.write("/f", [toBytes("streamed")]);
    expect(seen.every((v) => v === "yes")).toBe(true);
  });
});
