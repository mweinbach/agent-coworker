import { describe, expect, test } from "bun:test";

import {
  installLogBoxExceptionStackPatch,
  normalizeLogBoxException,
} from "../apps/mobile/src/polyfills/logbox";

describe("mobile LogBox polyfill", () => {
  test("normalizes Expo HMR build errors with string stacks", () => {
    const error = new Error("Metro has encountered an error");
    error.name = "InternalError";
    error.stack = "InternalError: Metro has encountered an error\n    at bundle.js:1:1";
    Object.assign(error, {
      originalMessage: "InternalError: Metro has encountered an error",
    });

    const normalized = normalizeLogBoxException(error);

    expect(normalized).toMatchObject({
      message: "Metro has encountered an error",
      originalMessage: "InternalError: Metro has encountered an error",
      name: "InternalError",
      stack: [],
      isFatal: false,
      isComponentError: false,
    });
  });

  test("leaves already-normalized exception stacks untouched", () => {
    const exception = {
      message: "Already parsed",
      originalMessage: "Already parsed",
      stack: [{ methodName: "render" }],
    };

    expect(normalizeLogBoxException(exception)).toBe(exception);
  });

  test("does not deep import native LogBox internals on web", () => {
    const originalDev = (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__;
    const originalDocument = (globalThis as typeof globalThis & { document?: unknown }).document;

    try {
      (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = true;
      (globalThis as typeof globalThis & { document?: unknown }).document = {};

      expect(() => installLogBoxExceptionStackPatch()).not.toThrow();
    } finally {
      (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = originalDev;
      if (typeof originalDocument === "undefined") {
        delete (globalThis as typeof globalThis & { document?: unknown }).document;
      } else {
        (globalThis as typeof globalThis & { document?: unknown }).document = originalDocument;
      }
    }
  });
});
