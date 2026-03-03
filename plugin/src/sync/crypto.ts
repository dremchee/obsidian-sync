import { argon2id } from "@noble/hashes/argon2";

function toB64(buf: Uint8Array) {
  let binary = "";
  for (const b of buf) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromB64(s: string) {
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function deriveKey(passphrase: string, salt: Uint8Array) {
  // Keep KDF cost moderate to avoid UI freezes in Obsidian plugin runtime.
  const raw = argon2id(passphrase, salt, { t: 1, m: 1 << 12, p: 1, dkLen: 32 });
  return crypto.subtle.importKey("raw", toArrayBuffer(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptBytes(passphrase: string, data: Uint8Array) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, toArrayBuffer(data));
  return {
    v: 1,
    alg: "AES-256-GCM",
    kdf: "Argon2id",
    salt: toB64(salt),
    iv: toB64(iv),
    ciphertext: toB64(new Uint8Array(ciphertext))
  };
}

export async function decryptBytes(passphrase: string, payload: { salt: string; iv: string; ciphertext: string }) {
  if (!payload || typeof payload !== "object") {
    throw new Error("CRYPTO_PAYLOAD_INVALID: payload is not an object");
  }
  if (typeof payload.salt !== "string" || typeof payload.iv !== "string" || typeof payload.ciphertext !== "string") {
    throw new Error("CRYPTO_PAYLOAD_INVALID: envelope fields are missing");
  }

  let salt: Uint8Array;
  let iv: Uint8Array;
  let raw: Uint8Array;
  try {
    salt = fromB64(payload.salt);
    iv = fromB64(payload.iv);
    raw = fromB64(payload.ciphertext);
  } catch {
    throw new Error("CRYPTO_PAYLOAD_INVALID: invalid base64 encoding");
  }

  if (salt.length < 8) {
    throw new Error(`CRYPTO_PAYLOAD_INVALID: salt too short (${salt.length})`);
  }
  if (iv.length < 12) {
    throw new Error(`CRYPTO_PAYLOAD_INVALID: iv too short (${iv.length})`);
  }

  const key = await deriveKey(passphrase, salt);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, toArrayBuffer(raw));
  return new Uint8Array(plaintext);
}

export function utf8Encode(input: string) {
  return new TextEncoder().encode(input);
}

export function utf8Decode(input: Uint8Array) {
  return new TextDecoder().decode(input);
}
