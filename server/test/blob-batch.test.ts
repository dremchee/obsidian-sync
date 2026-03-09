import { describe, expect, it } from "vitest";
import { encodeBlobBatchPayload, parseBlobBatchPayload } from "@shared/blob-batch";

describe("blob batch codec", () => {
  it("round-trips binary blob batch payloads", () => {
    const payload = encodeBlobBatchPayload({
      items: [
        { hash: "a".repeat(64), bytes: new TextEncoder().encode("A") },
        { hash: "b".repeat(64), bytes: new TextEncoder().encode("BC") }
      ],
      missing: ["c".repeat(64)],
      deferred: ["d".repeat(64)]
    });

    const decoded = parseBlobBatchPayload(payload);

    expect(decoded.missing).toEqual(["c".repeat(64)]);
    expect(decoded.deferred).toEqual(["d".repeat(64)]);
    expect(decoded.items.map((item) => item.hash)).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(decoded.items.map((item) => new TextDecoder().decode(item.bytes))).toEqual(["A", "BC"]);
  });
});
