import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    hookTimeout: 30000,
    testTimeout: 30000,
    include: ["test/**/*.test.ts"],
    // Each emulator binds a fixed TCP port; running suites in parallel makes two
    // services occasionally grab the same port (EADDRINUSE). Run test files
    // sequentially so every server has its port to itself — deterministic in CI.
    fileParallelism: false,
  },
});
