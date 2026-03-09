import { describe, expect, it, vi } from "vitest";
import { EngineClient } from "../src/sync/engine/client";
import { sha256Hex } from "../src/sync/engine/utils";
import { encodeBlobBatchPayload } from "../../shared/blob-batch";

describe("EngineClient blob batching", () => {
  it("retries deferred blob hashes from batch responses", async () => {
    const hashA = await sha256Hex(new TextEncoder().encode("A"));
    const hashB = await sha256Hex(new TextEncoder().encode("B"));
    const client = new EngineClient({
      serverUrl: "http://127.0.0.1:3243",
      apiKey: "api_key",
      authToken: "",
      vaultName: "",
      deviceId: "",
      passphrase: "",
      intervalSec: 30,
      maxConcurrentUploads: 2,
      pullBatchSize: 100,
      blobBatchSize: 10,
      retryBaseMs: 500,
      retryMaxMs: 30_000,
      lwwPolicy: "hard",
      enableWebSocket: true,
      debugPerfLogs: false,
      syncEnabled: true,
      syncOnStartup: true,
      startupMode: "smooth",
      bootstrapPolicy: "merge"
    }, () => {}) as never;

    const requestBinaryResponse = vi.spyOn(client as never as {
      requestBinaryResponse: (path: string, init: unknown) => Promise<Uint8Array>;
    }, "requestBinaryResponse");
    requestBinaryResponse
      .mockResolvedValueOnce(encodeBlobBatchPayload({
        items: [{ hash: hashA, bytes: new TextEncoder().encode("A") }],
        missing: [],
        deferred: [hashB]
      }))
      .mockResolvedValueOnce(encodeBlobBatchPayload({
        items: [{ hash: hashB, bytes: new TextEncoder().encode("B") }],
        missing: [],
        deferred: []
      }));

    const result = await client.downloadBlobsBatched([hashA, hashB]);

    expect(requestBinaryResponse).toHaveBeenCalledTimes(2);
    expect(Array.from(result.keys())).toEqual([hashA, hashB]);
    expect(Array.from(result.values()).map((bytes) => new TextDecoder().decode(bytes))).toEqual(["A", "B"]);
  });

  it("reduces batch size after deferred responses", async () => {
    const hashA = await sha256Hex(new TextEncoder().encode("A"));
    const hashB = await sha256Hex(new TextEncoder().encode("B"));
    const hashC = await sha256Hex(new TextEncoder().encode("C"));
    const client = new EngineClient({
      serverUrl: "http://127.0.0.1:3243",
      apiKey: "api_key",
      authToken: "",
      vaultName: "",
      deviceId: "",
      passphrase: "",
      intervalSec: 30,
      maxConcurrentUploads: 2,
      pullBatchSize: 100,
      blobBatchSize: 3,
      retryBaseMs: 500,
      retryMaxMs: 30_000,
      lwwPolicy: "hard",
      enableWebSocket: true,
      debugPerfLogs: false,
      syncEnabled: true,
      syncOnStartup: true,
      startupMode: "smooth",
      bootstrapPolicy: "merge"
    }, () => {}) as never;

    const requestBinaryResponse = vi.spyOn(client as never as {
      requestBinaryResponse: (path: string, init: { body: { hashes: string[] } }) => Promise<Uint8Array>;
    }, "requestBinaryResponse");
    requestBinaryResponse
      .mockResolvedValueOnce(encodeBlobBatchPayload({
        items: [{ hash: hashA, bytes: new TextEncoder().encode("A") }],
        missing: [],
        deferred: [hashB, hashC]
      }))
      .mockResolvedValueOnce(encodeBlobBatchPayload({
        items: [
          { hash: hashB, bytes: new TextEncoder().encode("B") },
          { hash: hashC, bytes: new TextEncoder().encode("C") }
        ],
        missing: [],
        deferred: []
      }));

    await client.downloadBlobsBatched([hashA, hashB, hashC]);

    expect(requestBinaryResponse).toHaveBeenNthCalledWith(
      1,
      "/api/v1/blobs/get",
      expect.objectContaining({
        body: { hashes: [hashA, hashB, hashC] }
      })
    );
    expect(requestBinaryResponse).toHaveBeenNthCalledWith(
      2,
      "/api/v1/blobs/get",
      expect.objectContaining({
        body: { hashes: [hashB, hashC] }
      })
    );
  });
});
