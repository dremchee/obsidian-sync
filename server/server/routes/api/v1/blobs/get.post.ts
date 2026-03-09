import { createError, defineEventHandler, readBody, sendStream, setHeader } from "h3";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { SERVER_SYNC_LIMITS } from "#app/constants";
import { hasBlob, statBlob, streamBlob } from "#app/utils/cas";
import { requireDevice } from "#app/utils/auth";
import { recordBlobBatchRequest, recordBlobDownloadBytes } from "#app/utils/metrics";
import {
  BLOB_BATCH_CONTENT_TYPE,
  buildBlobBatchEndFrame,
  buildBlobBatchHashFrame,
  buildBlobBatchItemHeader,
  BLOB_BATCH_FRAME_DEFERRED,
  BLOB_BATCH_FRAME_MISSING,
  buildBlobBatchPreamble
} from "../../../../../../shared/blob-batch";

type Body = { hashes?: string[] };

export default defineEventHandler(async (event) => {
  await requireDevice(event);
  const body = await readBody<Body>(event);
  const hashes = Array.isArray(body?.hashes) ? body.hashes : [];
  const normalized = normalizeHashes(hashes);

  const stream = new PassThrough();
  setHeader(event, "content-type", BLOB_BATCH_CONTENT_TYPE);
  void writeBlobBatch(stream, normalized);
  return sendStream(event, stream);
});

async function writeBlobBatch(stream: PassThrough, hashes: string[]) {
  try {
    if (!hashes.length) {
      await writeChunk(stream, buildBlobBatchPreamble());
      await writeChunk(stream, buildBlobBatchEndFrame());
      stream.end();
      return;
    }

    await writeChunk(stream, buildBlobBatchPreamble());

    let totalBytes = 0;
    let itemCount = 0;
    let deferredCount = 0;
    let missingCount = 0;
    for (const hash of hashes) {
      if (!(await hasBlob(hash))) {
        missingCount += 1;
        await writeChunk(stream, buildBlobBatchHashFrame(BLOB_BATCH_FRAME_MISSING, hash));
        continue;
      }

      const info = await statBlob(hash);
      if (totalBytes > 0 && totalBytes + info.size > SERVER_SYNC_LIMITS.blobBatchGetMaxBytes) {
        deferredCount += 1;
        await writeChunk(stream, buildBlobBatchHashFrame(BLOB_BATCH_FRAME_DEFERRED, hash));
        continue;
      }

      totalBytes += info.size;
      itemCount += 1;
      await writeChunk(stream, buildBlobBatchItemHeader(hash, info.size));
      await pipeBlobStream(stream, hash);
    }

    recordBlobDownloadBytes(totalBytes);
    recordBlobBatchRequest({
      items: itemCount,
      deferred: deferredCount,
      missing: missingCount
    });
    await writeChunk(stream, buildBlobBatchEndFrame());
    stream.end();
  } catch (error) {
    stream.destroy(error instanceof Error ? error : new Error(String(error)));
  }
}

async function pipeBlobStream(target: PassThrough, hash: string) {
  const source = streamBlob(hash);
  try {
    for await (const chunk of source) {
      await writeChunk(target, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } finally {
    source.destroy();
  }
}

async function writeChunk(stream: PassThrough, chunk: Uint8Array) {
  if (stream.write(chunk)) return;
  await once(stream, "drain");
}

function normalizeHashes(hashes: string[]) {
  if (hashes.length > SERVER_SYNC_LIMITS.blobBatchGetMaxHashes) {
    throw createError({
      statusCode: 400,
      statusMessage: `Too many hashes (max ${SERVER_SYNC_LIMITS.blobBatchGetMaxHashes})`
    });
  }

  const normalized = Array.from(new Set(hashes.map((hash) => String(hash).trim().toLowerCase())));
  for (const hash of normalized) {
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw createError({ statusCode: 400, statusMessage: `Invalid hash: ${hash}` });
    }
  }
  return normalized;
}
