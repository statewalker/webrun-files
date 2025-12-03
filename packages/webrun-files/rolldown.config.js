import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/index.ts",
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
  external: [],
  treeshake: true,
});
