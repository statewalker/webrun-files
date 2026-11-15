import { defineConfig } from "rolldown";
import { externalFor } from "../../scripts/rolldown-external.mjs";

// Dependencies stay imports: only src/ is bundled (scripts/rolldown-external.mjs).
const external = externalFor(import.meta.dirname);

export default defineConfig({
  input: "src/index.ts",
  external,
  output: [
    {
      dir: "dist/esm",
      format: "esm",
      entryFileNames: "[name].js",
      chunkFileNames: "[name]-[hash].js",
    },
    {
      dir: "dist/cjs",
      format: "cjs",
      entryFileNames: "[name].cjs",
      chunkFileNames: "[name]-[hash].cjs",
    },
  ],
  treeshake: true,
});
