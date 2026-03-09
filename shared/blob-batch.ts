const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const BLOB_BATCH_CONTENT_TYPE = "application/x-obsidian-sync-blob-batch";
export const BLOB_BATCH_MAGIC = textEncoder.encode("OSB1");
export const BLOB_BATCH_FRAME_ITEM = 1;
export const BLOB_BATCH_FRAME_MISSING = 2;
export const BLOB_BATCH_FRAME_DEFERRED = 3;
export const BLOB_BATCH_FRAME_END = 255;
const HASH_BYTES = 32;

export type BlobBatchItem = {
  hash: string;
  bytes: Uint8Array;
};

export type BlobBatchPayload = {
  items: BlobBatchItem[];
  missing: string[];
  deferred: string[];
};

function concatUint8Arrays(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function hashHexToBytes(hash: string) {
  const normalized = String(hash || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`Invalid blob hash: ${hash}`);
  }
  const out = new Uint8Array(HASH_BYTES);
  for (let i = 0; i < HASH_BYTES; i += 1) {
    out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function hashBytesToHex(bytes: Uint8Array) {
  if (bytes.byteLength !== HASH_BYTES) {
    throw new Error(`Invalid blob hash byte length: ${bytes.byteLength}`);
  }
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildBlobBatchPreamble() {
  return BLOB_BATCH_MAGIC.slice();
}

export function buildBlobBatchItemHeader(hash: string, byteLength: number) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > 0xffffffff) {
    throw new Error(`Invalid blob payload length: ${byteLength}`);
  }
  const out = new Uint8Array(1 + HASH_BYTES + 4);
  out[0] = BLOB_BATCH_FRAME_ITEM;
  out.set(hashHexToBytes(hash), 1);
  new DataView(out.buffer).setUint32(1 + HASH_BYTES, byteLength, false);
  return out;
}

export function buildBlobBatchHashFrame(kind: typeof BLOB_BATCH_FRAME_MISSING | typeof BLOB_BATCH_FRAME_DEFERRED, hash: string) {
  const out = new Uint8Array(1 + HASH_BYTES);
  out[0] = kind;
  out.set(hashHexToBytes(hash), 1);
  return out;
}

export function buildBlobBatchEndFrame() {
  return Uint8Array.of(BLOB_BATCH_FRAME_END);
}

export function encodeBlobBatchPayload(payload: BlobBatchPayload) {
  const chunks: Uint8Array[] = [buildBlobBatchPreamble()];
  for (const item of payload.items) {
    chunks.push(buildBlobBatchItemHeader(item.hash, item.bytes.byteLength));
    chunks.push(item.bytes);
  }
  for (const hash of payload.missing) {
    chunks.push(buildBlobBatchHashFrame(BLOB_BATCH_FRAME_MISSING, hash));
  }
  for (const hash of payload.deferred) {
    chunks.push(buildBlobBatchHashFrame(BLOB_BATCH_FRAME_DEFERRED, hash));
  }
  chunks.push(buildBlobBatchEndFrame());
  return concatUint8Arrays(chunks);
}

export function parseBlobBatchPayload(payload: Uint8Array): BlobBatchPayload {
  if (payload.byteLength < BLOB_BATCH_MAGIC.byteLength) {
    throw new Error("Invalid blob batch payload: missing preamble");
  }
  const preamble = payload.slice(0, BLOB_BATCH_MAGIC.byteLength);
  if (textDecoder.decode(preamble) !== textDecoder.decode(BLOB_BATCH_MAGIC)) {
    throw new Error("Invalid blob batch payload: bad preamble");
  }

  const items: BlobBatchItem[] = [];
  const missing: string[] = [];
  const deferred: string[] = [];
  let offset = BLOB_BATCH_MAGIC.byteLength;

  while (offset < payload.byteLength) {
    const frameType = payload[offset];
    offset += 1;

    if (frameType === BLOB_BATCH_FRAME_END) {
      return { items, missing, deferred };
    }

    if (frameType === BLOB_BATCH_FRAME_ITEM) {
      if (offset + HASH_BYTES + 4 > payload.byteLength) {
        throw new Error("Invalid blob batch payload: truncated item header");
      }
      const hash = hashBytesToHex(payload.slice(offset, offset + HASH_BYTES));
      offset += HASH_BYTES;
      const byteLength = new DataView(payload.buffer, payload.byteOffset + offset, 4).getUint32(0, false);
      offset += 4;
      if (offset + byteLength > payload.byteLength) {
        throw new Error("Invalid blob batch payload: truncated item body");
      }
      items.push({
        hash,
        bytes: payload.slice(offset, offset + byteLength)
      });
      offset += byteLength;
      continue;
    }

    if (frameType === BLOB_BATCH_FRAME_MISSING || frameType === BLOB_BATCH_FRAME_DEFERRED) {
      if (offset + HASH_BYTES > payload.byteLength) {
        throw new Error("Invalid blob batch payload: truncated hash frame");
      }
      const hash = hashBytesToHex(payload.slice(offset, offset + HASH_BYTES));
      offset += HASH_BYTES;
      if (frameType === BLOB_BATCH_FRAME_MISSING) {
        missing.push(hash);
      } else {
        deferred.push(hash);
      }
      continue;
    }

    throw new Error(`Invalid blob batch payload: unknown frame type ${frameType}`);
  }

  throw new Error("Invalid blob batch payload: missing end frame");
}
