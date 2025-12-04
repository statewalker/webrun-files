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
  external: [
    // AWS SDK must be external to use correct Node.js code paths
    /^@aws-sdk\//,
    /^@smithy\//,
    // Core package is external
    /^@statewalker\/webrun-files/,
  ],
  treeshake: true,
});
