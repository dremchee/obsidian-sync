function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  const arr = new Uint8Array(digest);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizePath(path: string | null | undefined): string {
  return String(path || "").replaceAll("\\", "/").replace(/^\/+/, "");
}

export function newOperationId() {
  return `lop_${crypto.randomUUID()}`;
}
