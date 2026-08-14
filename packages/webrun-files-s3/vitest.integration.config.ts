import { defineConfig } from "vitest/config";

/**
 * Integration profile: only the Docker-backed suites.
 *
 * Starts a RustFS container per run via testcontainers, so the first run pulls
 * the image — hence the long timeouts.
 */
export default defineConfig({
  test: {
    include: ["**/*.integration.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // Containers are shared through beforeAll; parallel files would race on them.
    fileParallelism: false,
  },
});
