import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { resolveDataPaths } from "#app/utils/paths";

export function sha256(input: Buffer) {
  return createHash("sha256").update(input).digest("hex");
}

export function blobPath(hash: string) {
  const { blobsPath } = resolveDataPaths();
  const p = path.join(blobsPath, hash.slice(0, 2), hash.slice(2, 4), `${hash}.bin`);
  return p;
}

export async function hasBlob(hash: string) {
  try {
    await fs.access(blobPath(hash));
    return true;
  } catch {
    return false;
  }
}

export async function putBlob(hash: string, payload: Buffer) {
  const p = blobPath(hash);
  await fs.mkdir(path.dirname(p), { recursive: true });
  if (!(await hasBlob(hash))) {
    await fs.writeFile(p, payload);
  }
  return p;
}

export async function readBlob(hash: string) {
  const p = blobPath(hash);
  return fs.readFile(p);
}

export async function statBlob(hash: string) {
  return fs.stat(blobPath(hash));
}

export function streamBlob(hash: string) {
  return createReadStream(blobPath(hash));
}

export async function putBlobFromStream(hash: string, input: Readable) {
  const { base } = resolveDataPaths();
  const targetPath = blobPath(hash);
  const tmpDir = path.join(base, "tmp", "uploads");
  const tmpPath = path.join(tmpDir, `${hash}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  const digest = createHash("sha256");
  let size = 0;

  await fs.mkdir(tmpDir, { recursive: true });
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  try {
    await pipeline(
      input,
      async function* (source) {
        for await (const chunk of source) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          digest.update(bytes);
          size += bytes.length;
          yield bytes;
        }
      },
      createWriteStream(tmpPath)
    );

    if (!size) {
      throw new Error("Missing binary payload");
    }

    const actual = digest.digest("hex");
    if (actual !== hash) {
      throw new Error(`Hash mismatch: expected ${hash}, got ${actual}`);
    }

    if (await hasBlob(hash)) {
      await fs.rm(tmpPath, { force: true });
      return { path: targetPath, size };
    }

    await fs.rename(tmpPath, targetPath);
    return { path: targetPath, size };
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function listAllBlobs() {
  const { blobsPath } = resolveDataPaths();
  const out: string[] = [];

  if (!(await hasDirectory(blobsPath))) {
    return out;
  }

  const first = await fs.readdir(blobsPath);
  for (const a of first) {
    const p1 = path.join(blobsPath, a);
    if (!(await isDirectory(p1))) continue;
    for (const b of await fs.readdir(p1)) {
      const p2 = path.join(p1, b);
      if (!(await isDirectory(p2))) continue;
      for (const f of await fs.readdir(p2)) {
        if (f.endsWith(".bin") && f.length > 4) {
          out.push(f.slice(0, -4));
        }
      }
    }
  }

  return out;
}

export async function deleteBlob(hash: string) {
  const p = blobPath(hash);
  if (await hasBlob(hash)) {
    await fs.unlink(p);
    return true;
  }
  return false;
}

async function hasDirectory(dirPath: string) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function isDirectory(dirPath: string) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
