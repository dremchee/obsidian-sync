import { webcrypto } from "node:crypto";

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true
  });
}

if (!globalThis.atob) {
  Object.defineProperty(globalThis, "atob", {
    value: (input: string) => Buffer.from(input, "base64").toString("binary"),
    configurable: true
  });
}

if (!globalThis.btoa) {
  Object.defineProperty(globalThis, "btoa", {
    value: (input: string) => Buffer.from(input, "binary").toString("base64"),
    configurable: true
  });
}
