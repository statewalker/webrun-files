// Mirrors the repository-level config, with a longer default timeout: the
// big-file suites stream 256 MiB through the stubs, in parallel test files.
export default {
  test: {
    globals: true,
    environment: "node",
    include: ["**/tests/**/*.test.ts"],
    testTimeout: 60_000,
  },
};
