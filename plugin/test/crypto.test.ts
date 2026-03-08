import { describe, expect, it } from "vitest";
import { decryptBytes, deriveKey, encryptBytes, utf8Decode, utf8Encode } from "../src/sync/crypto";

describe("sync crypto", () => {
  it("round-trips encrypted payloads", async () => {
    const plaintext = utf8Encode("obsidian sync keeps notes private");
    const encrypted = await encryptBytes("correct horse battery staple", plaintext);
    const decrypted = await decryptBytes("correct horse battery staple", encrypted);

    expect(utf8Decode(decrypted)).toBe("obsidian sync keeps notes private");
  });

  it("reuses derived keys for the same passphrase and salt", async () => {
    const salt = new Uint8Array(Array.from({ length: 16 }, (_, idx) => idx + 1));

    const first = await deriveKey("cache me", salt);
    const second = await deriveKey("cache me", salt);

    expect(first).toBe(second);
  });

  it("rejects malformed payloads before decryption", async () => {
    await expect(
      decryptBytes("secret", { salt: "", iv: "", ciphertext: "" })
    ).rejects.toThrow(/CRYPTO_PAYLOAD_INVALID/i);
  });
});
