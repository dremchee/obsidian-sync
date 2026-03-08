import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "#app": path.resolve(__dirname, "server/server"),
      obsidian: path.resolve(__dirname, "test/shims/obsidian.ts")
    }
  },
  test: {
    environment: "node",
    include: [
      "plugin/test/**/*.test.ts",
      "server/test/**/*.test.ts"
    ],
    setupFiles: ["./vitest.setup.ts"]
  }
});
