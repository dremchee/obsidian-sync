import { TFile, type Vault } from "obsidian";
import { toArrayBuffer, toUint8Array } from "./utils";

export async function readFileBytes(vault: Vault, file: TFile) {
  return toUint8Array(await vault.adapter.readBinary(file.path));
}

export async function writeBinaryFile(vault: Vault, path: string, bytes: Uint8Array) {
  await vault.adapter.writeBinary(path, toArrayBuffer(bytes));
}

export async function ensureDirectory(vault: Vault, dirPath: string) {
  if (await vault.adapter.exists(dirPath)) return;
  await vault.adapter.mkdir(dirPath);
}

export async function ensureParentDirectory(vault: Vault, path: string) {
  const parentDir = path.substring(0, path.lastIndexOf("/"));
  if (parentDir) {
    await ensureDirectory(vault, parentDir);
  }
}
