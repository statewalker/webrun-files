import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newHostRegistry } from "../src/deps/host-registry.js";
import { newModuleServer } from "../src/server/new-module-server.js";

// A project file that imports a provided module + uses a free global.
function projectWith(source: string) {
  const p = new MemFilesApi();
  return { p, ready: p.write("/app.ts", [new TextEncoder().encode(source)]) };
}

describe("~deps proxy layer", () => {
  it("rewrites a provided import to a ~deps proxy that reads the host registry", async () => {
    const registry = newHostRegistry({ react: { useState: () => 0, marker: "ME" } });
    const { p, ready } = projectWith(
      `import React, { useState } from "react";\nexport const v = useState;`,
    );
    await ready;
    const cache = new MemFilesApi();
    const server = newModuleServer({ cache, project: p, provided: registry });

    const res = await server.fetch(new Request("http://h/~/app.ts"));
    const code = await res.text();
    // The module imports only relative / ./~deps/* — no bare "react".
    expect(code).toContain("./~deps/app.ts/deps.react.js");
    expect(code).not.toContain('from "react"');

    // The proxy reads the shared registry (identity path).
    const proxy = await server.fetch(new Request("http://h/~/~deps/app.ts/deps.react.js"));
    const proxyCode = await proxy.text();
    expect(proxyCode).toContain('globalThis.__webrunHostRegistry.get("react")');
    expect(proxyCode).toContain("export const useState = __m.useState");
  });

  it("prepends a globals proxy import for a free global (process) and never for a declared one", async () => {
    const { p, ready } = projectWith(`export const env = process.env.NODE_ENV;`);
    await ready;
    const server = newModuleServer({ cache: new MemFilesApi(), project: p, target: "browser" });
    const code = await (await server.fetch(new Request("http://h/~/app.ts"))).text();
    expect(code).toContain("./~deps/app.ts/deps.globals.js");
    const g = await (
      await server.fetch(new Request("http://h/~/~deps/app.ts/deps.globals.js"))
    ).text();
    expect(g).toContain("export const process");
  });

  it("routes an ordinary npm import through a local proxy (custom source, no network)", async () => {
    // Minimal in-memory Source for a fake package "dep".
    const files = new MemFilesApi();
    await files.write("/index.js", [new TextEncoder().encode(`export const hi = 1;`)]);
    await files.write("/package.json", [
      new TextEncoder().encode(`{"name":"dep","version":"1.0.0"}`),
    ]);
    const source = {
      matches: (r: unknown) => typeof r === "object" && r !== null && "pkg" in r,
      load: async () => ({
        name: "dep",
        version: "1.0.0",
        files,
        manifest: { name: "dep", version: "1.0.0" },
      }),
    };
    const { p, ready } = projectWith(`import { hi } from "dep";\nexport const v = hi;`);
    await ready;
    const server = newModuleServer({
      cache: new MemFilesApi(),
      project: p,
      sources: [source as never],
    });
    const code = await (await server.fetch(new Request("http://h/~/app.ts"))).text();
    expect(code).toContain("./~deps/app.ts/deps.dep.js");
    const proxy = await (
      await server.fetch(new Request("http://h/~/~deps/app.ts/deps.dep.js"))
    ).text();
    expect(proxy).toContain("export { hi } from");
    expect(proxy).toContain("dep@1.0.0/index.js"); // re-exports the pinned local endpoint
  });

  it("sees a name registered LATE on the passed live registry (it IS the realm-global)", async () => {
    // The registry is empty at construction; `react` is set afterwards. Because a
    // live HostRegistry becomes globalThis[KEY], providedNames + the served proxy
    // both read the same object, so the late name binds to host (not local).
    const registry = newHostRegistry();
    const { p, ready } = projectWith(
      `import { useState } from "react";\nexport const v = useState;`,
    );
    await ready;
    const server = newModuleServer({ cache: new MemFilesApi(), project: p, provided: registry });
    registry.set("react", { useState: () => 0 }); // late registration

    const code = await (await server.fetch(new Request("http://h/~/app.ts"))).text();
    expect(code).toContain("./~deps/app.ts/deps.react.js");
    const proxy = await (
      await server.fetch(new Request("http://h/~/~deps/app.ts/deps.react.js"))
    ).text();
    expect(proxy).toContain('globalThis.__webrunHostRegistry.get("react")'); // host, not local
  });

  it("does not treat a free identifier named like an Object.prototype member as a global (I1)", async () => {
    // `toString` is a free global here, but it is NOT an own key of the allowlist —
    // `n in globalsMap` would falsely match it (prototype chain) and emit a broken
    // `export const toString = function toString(){…}` module. `Object.hasOwn` must not.
    const { p, ready } = projectWith(`export const x = toString;`);
    await ready;
    const server = newModuleServer({ cache: new MemFilesApi(), project: p });
    const code = await (await server.fetch(new Request("http://h/~/app.ts"))).text();
    expect(code).not.toContain("./~deps/app.ts/deps.globals.js"); // no globals proxy prepended
    expect(code).not.toContain("export const toString"); // never a broken globals export
    // and the (never-generated) globals proxy is a 404, not a syntax-error module
    const g = await server.fetch(new Request("http://h/~/~deps/app.ts/deps.globals.js"));
    expect(g.status).toBe(404);
  });

  it("binds a provided-root subpath to the registered root key, not the full spec (I2)", async () => {
    // Only `react` is registered; `react/jsx-runtime` (sucrase auto-injects it for
    // any JSX) must bind host to `react`, not the unregistered `react/jsx-runtime`.
    const { p, ready } = projectWith(
      `import { jsx } from "react/jsx-runtime";\nexport const j = jsx;`,
    );
    await ready;
    const rootServer = newModuleServer({
      cache: new MemFilesApi(),
      project: p,
      provided: newHostRegistry({ react: { jsx: () => 0 } }), // ROOT only
    });
    await rootServer.fetch(new Request("http://h/~/app.ts")); // generate the proxy
    const rootProxy = await (
      await rootServer.fetch(new Request("http://h/~/~deps/app.ts/deps.react__jsx-runtime.js"))
    ).text();
    expect(rootProxy).toContain('globalThis.__webrunHostRegistry.get("react")');
    expect(rootProxy).not.toContain('.get("react/jsx-runtime")');

    // …but an explicitly-registered subpath uses its own key (most specific wins).
    const { p: p2, ready: ready2 } = projectWith(
      `import { jsx } from "react/jsx-runtime";\nexport const j = jsx;`,
    );
    await ready2;
    const subServer = newModuleServer({
      cache: new MemFilesApi(),
      project: p2,
      provided: newHostRegistry({ "react/jsx-runtime": { jsx: () => 0 } }),
    });
    await subServer.fetch(new Request("http://h/~/app.ts")); // generate the proxy
    const subProxy = await (
      await subServer.fetch(new Request("http://h/~/~deps/app.ts/deps.react__jsx-runtime.js"))
    ).text();
    expect(subProxy).toContain('globalThis.__webrunHostRegistry.get("react/jsx-runtime")');
  });
});
