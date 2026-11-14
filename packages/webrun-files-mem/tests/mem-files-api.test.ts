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

describe("MemFilesApi.move is atomic", () => {
  const bytes = (text: string) => [new TextEncoder().encode(text)];
  const text = async (api: MemFilesApi, path: string) =>
    new TextDecoder().decode(await collectStream(api.read(path)));

  /**
   * Starts `move`, then starts a sample of `observe` right away and another at every
   * microtask turn until the move settles. Each sample reads the store in the turn it
   * starts, in one synchronous step, so it sees a state the store really was in.
   */
  async function sampleDuring<T>(
    move: () => Promise<boolean>,
    observe: () => Promise<T>,
  ): Promise<{ moved: boolean; samples: T[] }> {
    let settled = false;
    const moving = move().finally(() => {
      settled = true;
    });
    const samples: Promise<T>[] = [];
    do {
      samples.push(observe());
      await Promise.resolve();
    } while (!settled);
    return { moved: await moving, samples: await Promise.all(samples) };
  }

  it("replaces a file: the target never reads missing or empty, nor do both copies exist", async () => {
    const api = new MemFilesApi();
    await api.write("/repo/index.lock", bytes("new index"));
    await api.write("/repo/index", bytes("old index"));

    const { moved, samples } = await sampleDuring(
      () => api.move("/repo/index.lock", "/repo/index"),
      async () => {
        const [lock, index] = await Promise.all([
          api.exists("/repo/index.lock"),
          text(api, "/repo/index"),
        ]);
        return `${lock ? "lock" : "-"} ${index || "<missing or empty>"}`;
      },
    );

    expect(moved).toBe(true);
    for (const sample of samples) expect(["lock old index", "- new index"]).toContain(sample);
    expect(samples).toContain("- new index");
    expect(await text(api, "/repo/index")).toBe("new index");
    expect(await api.exists("/repo/index.lock")).toBe(false);
  });

  it("moves a directory: every file is under the source or every file is under the target", async () => {
    const api = new MemFilesApi();
    const names = ["a", "b/c", "b/d/e", "f/g"];
    for (const name of names) await api.write(`/src/${name}`, bytes(name));

    const { moved, samples } = await sampleDuring(
      () => api.move("/src", "/dst"),
      async () => {
        const where = await Promise.all(
          names.map(async (name) => {
            const [inSource, inTarget] = await Promise.all([
              text(api, `/src/${name}`),
              text(api, `/dst/${name}`),
            ]);
            return `${inSource ? "src" : ""}${inTarget ? "dst" : ""}`;
          }),
        );
        return where.join(",");
      },
    );

    expect(moved).toBe(true);
    const allSource = names.map(() => "src").join(",");
    const allTarget = names.map(() => "dst").join(",");
    for (const sample of samples) expect([allSource, allTarget]).toContain(sample);
    for (const name of names) expect(await text(api, `/dst/${name}`)).toBe(name);
    expect(await api.exists("/src")).toBe(false);
  });
});

describe("MemFilesApi.move onto an existing entry, as rename(2) does", () => {
  const bytes = (text: string) => [new TextEncoder().encode(text)];
  const text = async (api: MemFilesApi, path: string) =>
    new TextDecoder().decode(await collectStream(api.read(path)));
  const paths = async (api: MemFilesApi) =>
    (await collectGenerator(api.list("/", { recursive: true }))).map((e) => e.path);

  async function populated() {
    const api = new MemFilesApi();
    await api.write("/file.txt", bytes("file"));
    await api.write("/dir/a.txt", bytes("a"));
    await api.write("/dir/sub/b.txt", bytes("b"));
    await api.mkdir("/empty");
    await api.write("/full/x.txt", bytes("x"));
    return api;
  }

  it("replaces an empty directory with a directory", async () => {
    const api = await populated();
    expect(await api.move("/dir", "/empty")).toBe(true);
    expect(await text(api, "/empty/a.txt")).toBe("a");
    expect(await text(api, "/empty/sub/b.txt")).toBe("b");
    expect(await api.exists("/dir")).toBe(false);
  });

  for (const [what, source, target] of [
    ["a directory onto a non-empty directory", "/dir", "/full"],
    ["a file onto a directory", "/file.txt", "/empty"],
    ["a directory onto a file", "/dir", "/file.txt"],
    ["a directory into itself", "/dir", "/dir/sub/inner"],
    ["a directory onto its own parent", "/dir/sub", "/dir"],
    ["a file below a file", "/dir/a.txt", "/file.txt/a.txt"],
  ] as const) {
    it(`refuses ${what}: returns false and changes nothing`, async () => {
      const api = await populated();
      const before = await paths(api);
      expect(await api.move(source, target)).toBe(false);
      expect(await paths(api)).toEqual(before);
      expect(await text(api, "/file.txt")).toBe("file");
      expect(await text(api, "/dir/sub/b.txt")).toBe("b");
    });
  }

  it("treats a move onto itself as a successful no-op", async () => {
    const api = await populated();
    const before = await paths(api);
    expect(await api.move("/dir", "/dir")).toBe(true);
    expect(await api.move("/file.txt", "/file.txt")).toBe(true);
    expect(await paths(api)).toEqual(before);
  });
});

describe("MemFilesApi.move with a target that prefixes a sibling's name", () => {
  it("moves /a onto /ab without touching /abc", async () => {
    const api = new MemFilesApi();
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    await api.write("/a", [enc.encode("a")]);
    await api.write("/ab", [enc.encode("old ab")]);
    await api.write("/abc/x", [enc.encode("abc")]);
    expect(await api.move("/a", "/ab")).toBe(true);
    const listed = await collectGenerator(api.list("/", { recursive: true }));
    expect(listed.map((e) => e.path)).toEqual(["/ab", "/abc", "/abc/x"]);
    expect(dec.decode(await collectStream(api.read("/ab")))).toBe("a");
    expect(dec.decode(await collectStream(api.read("/abc/x")))).toBe("abc");
  });
});
