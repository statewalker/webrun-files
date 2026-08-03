import { describe, expect, it } from "vitest";
import {
  globalHostRegistry,
  HOST_REGISTRY_KEY,
  newHostRegistry,
} from "../src/deps/host-registry.js";

describe("host registry", () => {
  it("stores and retrieves instances by name", () => {
    const r = newHostRegistry({ react: { v: 1 } });
    expect(r.has("react")).toBe(true);
    expect(r.get("react")).toEqual({ v: 1 });
    r.set("x", 42);
    expect(r.get("x")).toBe(42);
  });

  it("globalHostRegistry is a single shared instance on globalThis", () => {
    const a = globalHostRegistry();
    const b = globalHostRegistry();
    expect(a).toBe(b);
    a.set("k", "v");
    expect((globalThis as Record<string, unknown>)[HOST_REGISTRY_KEY]).toBeDefined();
    expect(b.get("k")).toBe("v");
  });
});
