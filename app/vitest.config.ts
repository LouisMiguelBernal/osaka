import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Throwaway key so the encryption code runs under test. Never a real key.
    env: { FIELD_ENCRYPTION_KEY: "0".repeat(63) + "1" },
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/lib/**"],
      exclude: ["src/lib/**/*.test.ts", "src/lib/db.ts", "src/lib/schema.ts", "src/lib/ingest/service.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
});
