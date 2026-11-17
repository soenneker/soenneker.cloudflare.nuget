import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
export default defineConfig({
  plugins: [cloudflareTest({ main: "./src/index.ts", miniflare: {
    compatibilityDate: "2026-11-17", compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"], r2Buckets: ["PACKAGES"],
    bindings: { PUBLIC_URL: "https://nuget.test", READ_API_KEY: "read-key-at-least-thirty-two-characters", PUSH_API_KEY: "push-key-at-least-thirty-two-characters", INTERNAL_API_KEY: "internal-key-at-least-thirty-two-characters" }
  } })],
  test: { fileParallelism: false, testTimeout: 20000 }
});
