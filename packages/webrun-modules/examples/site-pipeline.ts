/**
 * Replacing the site-builder-jspm-demo's @jspm/generator pipeline with one
 * webrun-modules server. It serves first-party TS/TSX (transpiled, bare imports
 * rewritten) AND the npm dependencies — no jspm, no CDN providers, no separate
 * lex-rewrite / prefetch / external-mount machinery.
 *
 *   pnpm --filter @statewalker/webrun-modules exec tsx examples/site-pipeline.ts
 */
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { newModuleServer, npmRegistrySource } from "../src/index.js";

// The "user-authored" project — bare specifiers + JSX, exactly like the demo.
const project = new MemFilesApi();
await writeText(
  project,
  "/package.json",
  JSON.stringify({ type: "module", dependencies: { react: "^18" } }),
);
await writeText(
  project,
  "/index.html",
  `<!doctype html><html><body><div id="root"></div>\n<script type="module" src="./main.tsx"></script></body></html>`,
);
await writeText(
  project,
  "/main.tsx",
  `import { useState } from "react";
export function App(): JSX.Element {
  const [n] = useState<number>(0);
  return <h1>Hello {n} from webrun-modules</h1>;
}`,
);

const server = newModuleServer({
  cache: new MemFilesApi(),
  sources: [npmRegistrySource()],
  project,
  target: "browser",
  lock: { react: "18.3.1" }, // pin (a helper could derive this from package.json — see notes)
});

const req = (p: string) => new Request(`http://site${p}`);

// 1. index.html — served raw (non-module), references ./main.tsx
const html = await server.fetch(req("/~/index.html"));
console.log(`1. GET /~/index.html → ${html.status} ${html.headers.get("content-type")}`);

// 2. main.tsx — transpiled (TS + JSX stripped) with bare imports rewritten locally
const main = await server.fetch(req("/~/main.tsx"));
const js = await main.text();
console.log(`2. GET /~/main.tsx → ${main.status} ${main.headers.get("content-type")}`);
console.log("   imports (bare 'react' + JSX runtime → same-origin URLs):");
for (const m of js.matchAll(/import[^;]*from\s+("[^"]+")/g)) console.log(`     … from ${m[1]}`);
const jsxCompiled = /jsx(DEV|s?)\(/.test(js) && !js.includes("<h1>");
console.log(`   JSX compiled: ${jsxCompiled}; no bare specifier: ${!/from "react"/.test(js)}`);

// 3. the full set of scripts the client needs (replaces resolution-manifest.json)
const urls = await server.listResources({ url: "/main.tsx" });
console.log(`3. listResources → ${urls.length} modules to serve:`);
for (const u of urls) console.log(`     ${u}`);

console.log(
  "\n✓ One webrun-modules server = CdnResolver + providers + lex-rewrite + /external prefetch.",
);
console.log("  Wire into a site:  new SiteBuilder().setEndpoint('/', server.fetch)");
console.log(
  "                     .setEndpoint('/api', newServerRunner(serverEntryUrl, () => baseUrl))",
);
