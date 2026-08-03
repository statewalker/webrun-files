import { readText } from "@statewalker/webrun-files";
import { describe, expect, it } from "vitest";
import { npmRegistrySource, resolveVersion } from "../src/sources/npm-registry-source.js";
import { fakeFetch, makeTgz } from "./_fixtures.js";

const META = {
  "dist-tags": { latest: "1.2.0" },
  versions: {
    "1.0.0": {
      name: "demo",
      version: "1.0.0",
      dist: { tarball: "https://reg/demo/-/demo-1.0.0.tgz" },
    },
    "1.2.0": {
      name: "demo",
      version: "1.2.0",
      main: "./index.js",
      dist: { tarball: "https://reg/demo/-/demo-1.2.0.tgz" },
    },
  },
};

describe("resolveVersion", () => {
  const ref = { pkg: "demo" };
  it("resolves a dist-tag", () => expect(resolveVersion(META, "latest", ref)).toBe("1.2.0"));
  it("resolves undefined to latest", () =>
    expect(resolveVersion(META, undefined, ref)).toBe("1.2.0"));
  it("resolves an exact version", () => expect(resolveVersion(META, "1.0.0", ref)).toBe("1.0.0"));
  it("resolves a semver range to the max satisfying", () =>
    expect(resolveVersion(META, "^1.0.0", ref)).toBe("1.2.0"));
  it("throws when nothing satisfies", () =>
    expect(() => resolveVersion(META, "^9.0.0", ref)).toThrow(/no version satisfies/));
});

describe("npmRegistrySource", () => {
  const tgz = makeTgz({
    "package/package.json": '{"name":"demo","version":"1.2.0","main":"./index.js"}',
    "package/index.js": "export const hi = 1;",
  });
  const fetch = fakeFetch({
    "https://reg/demo": { json: META },
    "https://reg/demo/-/demo-1.2.0.tgz": { bytes: tgz },
  });
  const source = npmRegistrySource({ registryUrl: "https://reg", fetch });

  it("matches npm refs, not url refs", () => {
    expect(source.matches({ pkg: "demo" })).toBe(true);
    expect(source.matches({ url: "/x.js" })).toBe(false);
  });

  it("resolves version, untars into files, returns manifest", async () => {
    const pkg = await source.load({ pkg: "demo", version: "^1.0.0" });
    expect(pkg.name).toBe("demo");
    expect(pkg.version).toBe("1.2.0");
    expect(pkg.manifest.main).toBe("./index.js");
    expect(await readText(pkg.files, "/index.js")).toBe("export const hi = 1;");
    expect(await pkg.files.exists("/package.json")).toBe(true);
  });

  it("throws ModuleResolveError on a missing package", async () => {
    const s = npmRegistrySource({ registryUrl: "https://reg", fetch: fakeFetch({}) });
    await expect(s.load({ pkg: "nope" })).rejects.toThrow(/registry 404/);
  });
});
