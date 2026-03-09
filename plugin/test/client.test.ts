import { describe, expect, it, vi } from "vitest";
import { EngineClient } from "../src/sync/engine/client";
import { sha256Hex } from "../src/sync/engine/utils";

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

    const requestJson = vi.spyOn(client, "requestJson");
    requestJson
      .mockResolvedValueOnce({
        items: [{ hash: hashA, dataBase64: btoa("A") }],
        missing: [],
        deferred: [hashB]
      })
      .mockResolvedValueOnce({
        items: [{ hash: hashB, dataBase64: btoa("B") }],
        missing: [],
        deferred: []
      });

    const result = await client.downloadBlobsBatched([hashA, hashB]);

    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(Array.from(result.keys())).toEqual([hashA, hashB]);
    expect(Array.from(result.values()).map((bytes) => new TextDecoder().decode(bytes))).toEqual(["A", "B"]);
  });
});
