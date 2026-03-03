import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveDataPaths } from "#app/utils/paths";

export function sha256(input: Buffer) {
  return createHash("sha256").update(input).digest("hex");
}

export function blobPath(hash: string) {
  const { blobsPath } = resolveDataPaths();
  const p = path.join(blobsPath, hash.slice(0, 2), hash.slice(2, 4), `${hash}.bin`);
  return p;
}

export function hasBlob(hash: string) {
  return fs.existsSync(blobPath(hash));
}

export function putBlob(hash: string, payload: Buffer) {
  const p = blobPath(hash);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, payload);
  }
  return p;
}

export function readBlob(hash: string) {
  const p = blobPath(hash);
  return fs.readFileSync(p);
}

export function listAllBlobs() {
  const { blobsPath } = resolveDataPaths();
  const out: string[] = [];

  if (!fs.existsSync(blobsPath)) {
    return out;
  }

  const first = fs.readdirSync(blobsPath);
  for (const a of first) {
    const p1 = path.join(blobsPath, a);
    if (!fs.statSync(p1).isDirectory()) continue;
    for (const b of fs.readdirSync(p1)) {
      const p2 = path.join(p1, b);
      if (!fs.statSync(p2).isDirectory()) continue;
      for (const f of fs.readdirSync(p2)) {
        if (f.endsWith(".bin") && f.length > 4) {
          out.push(f.slice(0, -4));
        }
      }
    }
  }

  return out;
}

export function deleteBlob(hash: string) {
  const p = blobPath(hash);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    return true;
  }
  return false;
}
