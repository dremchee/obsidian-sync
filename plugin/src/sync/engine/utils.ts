import { normalizeSyncPath } from "@shared/path";

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function toUint8Array(data: ArrayBuffer | Uint8Array) {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export function byteArraysEqual(a: Uint8Array, b: Uint8Array) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  const arr = new Uint8Array(digest);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizePath(path: string | null | undefined): string {
  return normalizeSyncPath(path);
}

export function newOperationId() {
  return `lop_${crypto.randomUUID()}`;
}
