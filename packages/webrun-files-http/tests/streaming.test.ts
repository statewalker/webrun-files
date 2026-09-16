/** Real streams in both directions, measured in direct mode where both ends are visible. */
import type { FilesApi, ReadOptions } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { collectStream, positionContent } from "@statewalker/webrun-files-tests";
import { describe, expect, it } from "vitest";
import { direct } from "./helpers.js";

const KiB = 1024;

describe("streamed upload", () => {
  it("pulls the source only as the served file system consumes the body", async () => {
    let pulled = 0;
    let consumed = 0;
    let worst = 0;
    const fs = new MemFilesApi();
    const write = fs.write.bind(fs);
    fs.write = async (path, content) => {
      async function* slow() {
        for await (const chunk of content) {
          consumed += chunk.length;
          worst = Math.max(worst, pulled - consumed);
          await new Promise((r) => setTimeout(r, 0));
          yield chunk;
        }
      }
      return write(path, slow());
    };
    const { client } = await direct({ fs, client: { upload: "stream" } });
    async function* source() {
      for await (const chunk of positionContent(512 * KiB, [16 * KiB])) {
        pulled += chunk.length;
        yield chunk;
      }
    }
    await client.write("/f", source());
    expect(consumed).toBe(512 * KiB);
    // The pipe holds at most a chunk or two between source and consumer.
    expect(worst).toBeLessThanOrEqual(2 * 16 * KiB);
  });

  it("fails the write, leaving the previous content, when the source throws", async () => {
    const { fs, client } = await direct({ client: { upload: "stream" } });
    await fs.write("/f", [new TextEncoder().encode("previous")]);
    async function* failing() {
      yield new Uint8Array(10);
      throw new Error("source broke");
    }
    await expect(client.write("/f", failing())).rejects.toThrow("source broke");
    expect(new TextDecoder().decode(await collectStream(fs.read("/f")))).toBe("previous");
  });
});

describe("streamed read", () => {
  function instrumented() {
    const fs = new MemFilesApi();
    const state = { pulled: 0, returned: false };
    const read = fs.read.bind(fs);
    (fs as FilesApi).read = (path: string, options?: ReadOptions) =>
      (async function* () {
        try {
          // Re-chunk so the server stream has many small pieces to pace.
          for await (const chunk of read(path, options)) {
            for (let at = 0; at < chunk.length; at += 4 * KiB) {
              const piece = chunk.subarray(at, at + 4 * KiB);
              state.pulled += piece.length;
              yield piece;
            }
          }
        } finally {
          state.returned = true;
        }
      })();
    return { fs, state };
  }

  it("reads from the file system only as the client consumes", async () => {
    const { fs, state } = instrumented();
    await fs.write("/f", positionContent(1024 * KiB, [1024 * KiB]));
    const { client } = await direct({ fs });
    let consumed = 0;
    let worst = 0;
    for await (const chunk of client.read("/f")) {
      consumed += chunk.length;
      worst = Math.max(worst, state.pulled - consumed);
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(consumed).toBe(1024 * KiB);
    expect(worst).toBeLessThanOrEqual(2 * 4 * KiB);
  });

  it("returns the server-side iterator when the client stops early", async () => {
    const { fs, state } = instrumented();
    await fs.write("/f", positionContent(1024 * KiB, [1024 * KiB]));
    const { client } = await direct({ fs });
    for await (const _ of client.read("/f")) break;
    await new Promise((r) => setTimeout(r, 10));
    expect(state.returned).toBe(true);
    expect(state.pulled).toBeLessThan(64 * KiB);
  });

  it("passes the AbortSignal to fetch", async () => {
    const { fs } = instrumented();
    await fs.write("/f", positionContent(64 * KiB));
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const { client } = await direct({
      fs,
      wrapFetch: (server) => async (req) => {
        signal = req.signal;
        return server(req);
      },
    });
    await collectStream(client.read("/f", { signal: controller.signal }));
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });
});
