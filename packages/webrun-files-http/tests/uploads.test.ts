import { positionContent } from "@statewalker/webrun-files-tests";
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
