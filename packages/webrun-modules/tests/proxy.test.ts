import { describe, expect, it } from "vitest";
import { proxyBody, proxyId } from "../src/deps/proxy.js";

describe("proxyId", () => {
  it("co-locates under ~deps/<basename>/ and slugs the specifier", () => {
    expect(proxyId("pkg@1/dir/foo.js", "react")).toBe("pkg@1/dir/~deps/foo.js/deps.react.js");
    expect(proxyId("pkg@1/foo.js", "react/jsx-runtime")).toBe(
      "pkg@1/~deps/foo.js/deps.react__jsx-runtime.js",
    );
    expect(proxyId("~/app.ts", "")).toBe("~/~deps/app.ts/deps.globals.js");
  });
});

describe("proxyBody", () => {
  it("local binding re-exports names + default + namespace from the relative endpoint", () => {
    const id = proxyId("pkg@1/foo.js", "lodash-es");
    const body = proxyBody({
      proxyId: id,
      binding: { kind: "local", url: "IGNORED" },
      imp: { names: ["debounce"], hasNamespace: true, hasDefault: false },
      registryKey: "__webrunHostRegistry",
    });
    // endpoint is resolved by the server and passed as binding.url; here we assert re-export shape
    expect(body).toContain("export { debounce } from");
    expect(body).toContain("export * from");
  });

  it("host binding reads the shared registry and preserves the instance as default", () => {
    const id = proxyId("pkg@1/foo.js", "react");
    const body = proxyBody({
      proxyId: id,
      binding: { kind: "host", name: "react" },
      imp: { names: ["useState"], hasNamespace: false, hasDefault: true },
      registryKey: "__webrunHostRegistry",
    });
    expect(body).toContain('globalThis.__webrunHostRegistry.get("react")');
    expect(body).toContain("export default __m");
    expect(body).toContain("export const useState = __m.useState");
  });
});
