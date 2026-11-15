import { defineConfig } from "rolldown";
import { externalFor } from "../../scripts/rolldown-external.mjs";

// Dependencies stay imports: only src/ is bundled (scripts/rolldown-external.mjs). The CJS build
// also bundles any dependency that cannot be `require`d.
const external = externalFor(import.meta.dirname);
const cjsExternal = externalFor(import.meta.dirname, { format: "cjs" });

export default defineConfig([
  {
    input: "src/index.ts",
    external,
    output: {
      dir: "dist/esm",
      format: "esm",
      entryFileNames: "[name].js",
    },
  },
  {
    input: "src/index.ts",
    external: cjsExternal,
    output: {
      dir: "dist/cjs",
      format: "cjs",
      entryFileNames: "[name].cjs",
    },
  },
]);
