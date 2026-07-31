import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": resolve(import.meta.dirname) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    exclude: ["node_modules/**", ".next/**", "cache/**", "out/**", "contract/**"],
    setupFiles: ["tests/setup.js"],
    // Integration tests hit the real Supabase project over the network.
    testTimeout: 30000,
    hookTimeout: 30000,
    // duel-store keeps module-level state, so isolate files from each other.
    fileParallelism: false,
    // Contract tests live in Foundry (`forge test`), not here.
  },
});
