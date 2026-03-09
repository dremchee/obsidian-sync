import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(rootDir, "src"),
      "@shared": resolve(rootDir, "../shared")
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: resolve(rootDir, "main.ts"),
      formats: ["cjs"],
      fileName: () => "main.js"
    },
    rollupOptions: {
      external: ["obsidian"]
    },
    target: "es2022"
  }
});
