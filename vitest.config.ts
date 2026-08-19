// Exported as a plain object rather than via `defineConfig` from "vitest/config".
// This file is loaded by every package's `vitest run`, but the repo root is not
// itself a workspace package, so it has no node_modules and an import of
// "vitest/config" cannot resolve from here — which made every package's test
// script fail with ERR_MODULE_NOT_FOUND. `defineConfig` is only a typing
// helper, so dropping it costs nothing and makes this config resolvable from
// any package.
export default {
  test: {
    globals: true,
    environment: "node",
    include: ["**/tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
};
