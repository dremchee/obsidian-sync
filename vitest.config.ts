import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "#app": path.resolve(__dirname, "server/server")
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
