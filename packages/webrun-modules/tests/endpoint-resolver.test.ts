import { describe, expect, it } from "vitest";
import { newDefaultEndpointResolver } from "../src/deps/endpoint-resolver.js";

const ctx = { importerId: "app@1/index.js", target: "browser" as const };

describe("default endpoint resolver", () => {
  it("binds provided names to host", async () => {
    const r = newDefaultEndpointResolver({
      providedNames: (n) => n === "react" || n === "",
      localUrl: async () => "SHOULD_NOT_BE_CALLED",
    });
    expect(await r.resolve("react", ctx)).toEqual({ kind: "host", name: "react" });
    expect(await r.resolve("", ctx)).toEqual({ kind: "host", name: "" });
  });

  it("binds everything else to local via the injected localUrl", async () => {
    const r = newDefaultEndpointResolver({
      providedNames: () => false,
      localUrl: async (spec) => `../../${spec}@1.0.0/index.js`,
    });
    expect(await r.resolve("lodash-es", ctx)).toEqual({
      kind: "local",
      url: "../../lodash-es@1.0.0/index.js",
    });
  });
});
