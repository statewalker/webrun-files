/**
 * Regression tests for statewalker/webrun-files#40: a path with `..` segments
 * must not slip past a filter, a guard or a mount boundary. The decorators
 * decide on the normalized path; a node backend resolves `..` before it
 * touches disk, so both must see the same path.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CompositeFilesApi,
  FilteredFilesApi,
  GuardedFilesApi,
  newPathFilter,
} from "../src/index.js";

const toBytes = (text: string) => new TextEncoder().encode(text);

/** The text a read yields, or `undefined` when the call is refused (sync throw or rejection). */
async function tryRead(read: () => AsyncIterable<Uint8Array>): Promise<string | undefined> {
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of read()) chunks.push(chunk);
    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch {
    return undefined;
  }
}

/** Whether the call succeeded; a refusal (sync throw or rejection) is `false`. */
async function succeeds(call: () => unknown): Promise<boolean> {
  try {
    await call();
    return true;
  } catch {
    return false;
  }
}

describe('".." paths over a node backend (#40)', () => {
  let dir: string;
  let node: NodeFilesApi;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "webrun-files-dotdot-"));
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git", "config"), "secret");
    node = new NodeFilesApi({ rootDir: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("FilteredFilesApi hides /x/../.git/config behind a /.git filter", async () => {
    const api = new FilteredFilesApi(node, newPathFilter("/.git"));
    expect(await tryRead(() => api.read("/.git/config"))).not.toBe("secret");
    expect(await tryRead(() => api.read("/x/../.git/config"))).not.toBe("secret");
    const exists = await Promise.resolve()
      .then(() => api.exists("/x/../.git/config"))
      .catch(() => false);
    expect(exists).toBe(false);
    expect(await succeeds(() => api.write("/x/../.git/config", [toBytes("pwned")]))).toBe(false);
    expect(await readFile(join(dir, ".git", "config"), "utf8")).toBe("secret");
  });

  it("GuardedFilesApi refuses /x/../.git/config under a /.git guard", async () => {
    const api = new GuardedFilesApi(node, [
      {
        operations: ["read", "write", "list"],
        check: (p) => p !== "/.git" && !p.startsWith("/.git/"),
      },
    ]);
    expect(await tryRead(() => api.read("/x/../.git/config"))).toBeUndefined();
    expect(await succeeds(() => api.write("/x/../.git/config", [toBytes("pwned")]))).toBe(false);
    expect(await succeeds(() => api.stats("/x/../.git/config"))).toBe(false);
    expect(await readFile(join(dir, ".git", "config"), "utf8")).toBe("secret");
  });

  it("CompositeFilesApi keeps /m/../y out of the mount's basePath", async () => {
    await mkdir(join(dir, "base"));
    await writeFile(join(dir, "outside.txt"), "outside");
    const api = new CompositeFilesApi(new NodeFilesApi({ rootDir: join(dir, "base") }));
    api.mount("/m", node, "/base");

    // /m/../outside.txt is /outside.txt in the composite: served by the root
    // mount (whose rootDir is <dir>/base), never by /m reaching <dir>/outside.txt.
    expect(await tryRead(() => api.read("/m/../outside.txt"))).not.toBe("outside");
    expect(await tryRead(() => api.read("/m/../../outside.txt"))).toBeUndefined();

    await api.write("/m/../y.txt", [toBytes("y")]);
    expect(await readFile(join(dir, "base", "y.txt"), "utf8")).toBe("y");
    expect(await succeeds(() => readFile(join(dir, "y.txt")))).toBe(false);
  });
});
