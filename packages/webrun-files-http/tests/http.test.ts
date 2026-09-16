import { collectStream, createFilesApiTests, toBytes } from "@statewalker/webrun-files-tests";
import { describe, expect, it } from "vitest";
import { overHttp } from "./hono-server.js";

createFilesApiTests("HTTP stubs over Hono + @hono/node-server (streamed upload)", async () => {
  const { client, close } = await overHttp({ client: { upload: "stream" } });
  return { api: client, cleanup: close };
});

createFilesApiTests(
  "HTTP stubs over Hono + @hono/node-server (chunked upload, POST verbs)",
  async () => {
    const { client, close } = await overHttp({
      server: { minPartSize: 4096 },
      client: { upload: "chunked", partSize: 4096, methods: "post", pageSize: 3 },
    });
    return { api: client, cleanup: close };
  },
);

describe("over a real HTTP connection", () => {
  it("uses the WebDAV verbs end to end", async () => {
    const { fs, client, close } = await overHttp();
    try {
      await client.write("/a.txt", [toBytes("hello")]);
      await client.mkdir("/dir");
      expect(await client.copy("/a.txt", "/dir/b.txt")).toBe(true);
      expect(await client.move("/dir/b.txt", "/dir/c.txt")).toBe(true);
      expect(new TextDecoder().decode(await collectStream(fs.read("/dir/c.txt")))).toBe("hello");
      expect(await client.remove("/dir")).toBe(true);
    } finally {
      await close();
    }
  });

  it("chooses streamed uploads automatically in Node", async () => {
    const { client, port, close } = await overHttp({ client: { upload: "auto" } });
    try {
      const puts: string[] = [];
      const original = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        puts.push(`${req.method} ${new URL(req.url).search}`);
        return original(req);
      };
      try {
        await client.write("/f.bin", [new Uint8Array(20 * 1024 * 1024)]);
      } finally {
        globalThis.fetch = original;
      }
      expect(puts).toEqual(["PUT "]);
      expect(port).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });
});
