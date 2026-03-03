import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const distDir = resolve(rootDir, "dist");

mkdirSync(distDir, { recursive: true });
copyFileSync(resolve(rootDir, "manifest.json"), resolve(distDir, "manifest.json"));
