import { toBytes } from "@statewalker/webrun-files-tests";
import { afterEach, describe, expect, it, vi } from "vitest";
import { direct } from "./helpers.js";

/** A Request that behaves like Firefox's: it never reads `duplex` and stringifies a stream body. */
class FirefoxLikeRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const body = init?.body instanceof ReadableStream ? String(init.body) : init?.body;
    const { duplex: _ignored, ...rest } = (init ?? {}) as RequestInit & { duplex?: string };
    super(input, init ? { ...rest, body } : undefined);
  }
}

describe("upload mode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses an explicit streamed upload where request streams are unsupported, storing nothing", async () => {
    const { fs, client } = await direct({ client: { upload: "stream" } });
    vi.stubGlobal("Request", FirefoxLikeRequest);
    await expect(client.write("/f.txt", [toBytes("content")])).rejects.toThrow(
      /cannot stream request bodies/,
    );
    vi.unstubAllGlobals();
    expect(await fs.exists("/f.txt")).toBe(false);
  });

  it("chooses chunked uploads automatically where request streams are unsupported", async () => {
    vi.stubGlobal("Request", FirefoxLikeRequest);
    const requests: string[] = [];
    const { fs, client } = await direct({
      client: { upload: "auto" },
      wrapFetch: (server) => async (req) => {
        requests.push(req.method);
        return server(req);
      },
    });
    await client.write("/f.txt", [toBytes("content")]);
    vi.unstubAllGlobals();
    expect(await fs.exists("/f.txt")).toBe(true);
    expect(requests.at(-1)).toBe("PUT");
  });
});
