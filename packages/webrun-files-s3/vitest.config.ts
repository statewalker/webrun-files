import { configDefaults, defineConfig } from "vitest/config";

/**
 * Default profile: unit tests only.
 *
 * Integration tests (`*.integration.test.ts`) need Docker and are excluded here
 * so `pnpm test` stays runnable everywhere, including CI without a daemon.
 * Run them with `pnpm test:integration`.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
});
