// Mirrors the repository-level config, plus a longer default timeout: this
// package runs three 256 MiB big-file suites in parallel test files, and the
// CPU they take stretches small streaming tests well past vitest's 5 s default.
export default {
  test: {
    globals: true,
    environment: "node",
    include: ["**/tests/**/*.test.ts"],
    testTimeout: 60_000,
  },
};
