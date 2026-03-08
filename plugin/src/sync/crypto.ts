import { argon2id } from "@noble/hashes/argon2";

const ARGON2_TIME_COST = 2;
const ARGON2_MEMORY_COST = 1 << 14;
const ARGON2_PARALLELISM = 1;
const DERIVED_KEY_CACHE_LIMIT = 128;
const derivedKeyCache = new Map<string, Promise<CryptoKey>>();

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

function makeDerivedKeyCacheKey(passphrase: string, salt: Uint8Array) {
  return `${passphrase}\u0000${toB64(salt)}`;
}

function rememberDerivedKey(cacheKey: string, value: Promise<CryptoKey>) {
  derivedKeyCache.delete(cacheKey);
  derivedKeyCache.set(cacheKey, value);
  if (derivedKeyCache.size <= DERIVED_KEY_CACHE_LIMIT) {
    return value;
  }

  const oldestKey = derivedKeyCache.keys().next().value;
  if (typeof oldestKey === "string") {
    derivedKeyCache.delete(oldestKey);
  }
  return value;
}

export async function deriveKey(passphrase: string, salt: Uint8Array) {
  const cacheKey = makeDerivedKeyCacheKey(passphrase, salt);
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const derivedKeyPromise = (async () => {
    const raw = argon2id(passphrase, salt, {
      t: ARGON2_TIME_COST,
      m: ARGON2_MEMORY_COST,
      p: ARGON2_PARALLELISM,
      dkLen: 32
    });
    return crypto.subtle.importKey("raw", toArrayBuffer(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  })();

  rememberDerivedKey(cacheKey, derivedKeyPromise);
  try {
    return await derivedKeyPromise;
  } catch (err) {
    derivedKeyCache.delete(cacheKey);
    throw err;
  }
}

export async function encryptBytes(passphrase: string, data: Uint8Array) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(data));
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
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(raw));
  return new Uint8Array(plaintext);
}

export function utf8Encode(input: string) {
  return new TextEncoder().encode(input);
}

export function utf8Decode(input: Uint8Array) {
  return new TextDecoder().decode(input);
}
