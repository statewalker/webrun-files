import { defineConfig } from "rolldown";

// Library ESM build at dist/index.js. Dependencies stay external (consumers
// install them via npm) — only this package's own source is bundled.
export default defineConfig({
  input: "src/index.ts",
  output: {
    file: "dist/index.js",
    format: "esm",
  },
  external: (id) => !id.startsWith(".") && !id.startsWith("/"),
  treeshake: true,
});
