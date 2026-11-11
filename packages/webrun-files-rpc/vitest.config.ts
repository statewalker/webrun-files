// Mirrors the repository-level config, with a longer default timeout: the protocol tests move a
// few MiB through the transport simulator, and the conformance suite streams large files.
export default {
  test: {
    globals: true,
    environment: "node",
    include: ["**/tests/**/*.test.ts"],
    testTimeout: 60_000,
  },
};
