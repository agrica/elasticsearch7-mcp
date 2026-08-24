import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The same process-level net index.ts installs — see the file for why.
    setupFiles: ["test/support/setup.ts"],
  },
});
