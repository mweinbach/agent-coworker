import * as ExpoCrypto from "expo-crypto";

type CryptoShim = {
  getRandomValues?: typeof ExpoCrypto.getRandomValues;
  randomUUID?: typeof ExpoCrypto.randomUUID;
};

const existingCrypto = typeof globalThis.crypto === "object" && globalThis.crypto
  ? (globalThis.crypto as CryptoShim)
  : null;

const cryptoShim: CryptoShim = existingCrypto ?? {};

if (typeof cryptoShim.getRandomValues !== "function") {
  cryptoShim.getRandomValues = ExpoCrypto.getRandomValues;
}

if (typeof cryptoShim.randomUUID !== "function") {
  cryptoShim.randomUUID = ExpoCrypto.randomUUID;
}

if (existingCrypto !== cryptoShim) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: cryptoShim,
  });
}
