import {
  collectGenerator,
  collectStream,
  createFilesApiTests,
} from "@statewalker/webrun-files-tests";
import { describe, expect, it } from "vitest";
import { MemFilesApi } from "../src/index.js";

createFilesApiTests("MemFilesApi", async () => ({
  api: new MemFilesApi(),
}));

describe("MemFilesApi.createExclusive", () => {
  const bytes = (text: string) => [new TextEncoder().encode(text)];

  /** A source that yields one chunk, then waits for `release()`. */
  function stalled(text: string) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* source() {
      yield new TextEncoder().encode(text);
      await gate;
    }
    return { source: source(), release };
  }

  it("refuses a path under an existing file", async () => {
    const api = new MemFilesApi({ initialFiles: { "/a": "file" } });
    expect(await api.createExclusive("/a/b.lock", bytes("x"))).toBe(false);
    expect(await api.stats("/a")).toMatchObject({ kind: "file" });
    expect(await api.exists("/a/b.lock")).toBe(false);
  });

  it("refuses when an ancestor becomes a file while the content is collected", async () => {
    const api = new MemFilesApi();
    const { source, release } = stalled("x");
    const pending = api.createExclusive("/d/e.lock", source);
    await api.write("/d", bytes("file"));
    release();
    expect(await pending).toBe(false);
    expect(await api.stats("/d")).toMatchObject({ kind: "file", size: 4 });
    expect(await api.exists("/d/e.lock")).toBe(false);
  });

  it("hides a reserved file from read, stats, exists and list until complete", async () => {
    const api = new MemFilesApi();
    const { source, release } = stalled("content");
    const pending = api.createExclusive("/dir/x.lock", source);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await collectStream(api.read("/dir/x.lock"))).toHaveLength(0);
    expect(await api.stats("/dir/x.lock")).toBeUndefined();
    expect(await api.exists("/dir/x.lock")).toBe(false);
    expect(await api.exists("/dir")).toBe(false);
    expect(await collectGenerator(api.list("/", { recursive: true }))).toEqual([]);
    // ...but another createExclusive sees the reservation.
    expect(await api.createExclusive("/dir/x.lock", bytes("other"))).toBe(false);

    release();
    expect(await pending).toBe(true);
    expect(new TextDecoder().decode(await collectStream(api.read("/dir/x.lock")))).toBe("content");
  });

  it("brings the file back after its parent is removed or moved meanwhile", async () => {
    const api = new MemFilesApi();
    await api.mkdir("/p");
    await api.write("/p/keep.txt", bytes("keep"));
    const { source, release } = stalled("lock");
    const pending = api.createExclusive("/p/x.lock", source);
    expect(await api.move("/p", "/q")).toBe(true);
    expect(await api.remove("/q")).toBe(true);
    release();
    expect(await pending).toBe(true);
    expect(await api.exists("/p/x.lock")).toBe(true);
    expect(await api.exists("/p/keep.txt")).toBe(false);
  });
});
