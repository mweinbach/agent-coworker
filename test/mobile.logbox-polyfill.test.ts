import { describe, expect, test } from "bun:test";

import { normalizeLogBoxException } from "../apps/mobile/src/polyfills/logbox";

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
});
