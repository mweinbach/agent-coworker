import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type RunCommand = (command: string, args: string[]) => void;

type NotarizePrivate = {
  isRetryableNotarizeError(error: unknown): boolean;
  notarizeWithRetry(
    notarize: (options: Record<string, unknown>) => Promise<void>,
    options: Record<string, unknown>,
    retryOptions: {
      logger: { warn(message: string): void };
      maxAttempts: number;
      retryDelayMs: number;
      sleep(ms: number): Promise<void>;
    },
  ): Promise<void>;
  stapleNotarizedApp(
    appPath: string,
    options: { logger: { log(message: string): void }; runCommand: RunCommand },
  ): void;
};

const notarizeModule = require("../scripts/notarize.cjs") as {
  __private: NotarizePrivate;
};

const { isRetryableNotarizeError, notarizeWithRetry, stapleNotarizedApp } =
  notarizeModule.__private;

describe("desktop notarization helper", () => {
  test("classifies transient Apple notarization network errors as retryable", () => {
    expect(
      isRetryableNotarizeError(
        new Error(
          'HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=-1009 "The Internet connection appears to be offline.")',
        ),
      ),
    ).toBe(true);
    expect(isRetryableNotarizeError(new Error("request failed with ETIMEDOUT"))).toBe(true);
    expect(isRetryableNotarizeError(new Error("statusCode: 503"))).toBe(true);
  });

  test("does not retry permanent notarization failures", () => {
    expect(isRetryableNotarizeError(new Error("Invalid credentials"))).toBe(false);
  });

  test("retries transient notarization failures before succeeding", async () => {
    const attempts: Array<Record<string, unknown>> = [];
    const delays: number[] = [];
    const warnings: string[] = [];

    await notarizeWithRetry(
      async (options) => {
        attempts.push(options);
        if (attempts.length < 3) {
          throw new Error("NSURLErrorDomain Code=-1009");
        }
      },
      { appBundleId: "co.weinbach.cowork" },
      {
        logger: { warn: (message) => warnings.push(message) },
        maxAttempts: 4,
        retryDelayMs: 25,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(attempts).toHaveLength(3);
    expect(delays).toEqual([25, 25]);
    expect(warnings).toHaveLength(2);
  });

  test("stops retrying after the configured attempt limit", async () => {
    let attempts = 0;

    await expect(
      notarizeWithRetry(
        async () => {
          attempts += 1;
          throw new Error("NSURLErrorDomain Code=-1009");
        },
        {},
        {
          logger: { warn: () => {} },
          maxAttempts: 2,
          retryDelayMs: 0,
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow("NSURLErrorDomain Code=-1009");

    expect(attempts).toBe(2);
  });

  test("staples the notarization ticket onto the app bundle", () => {
    const calls: Array<[string, string[]]> = [];
    const logs: string[] = [];

    stapleNotarizedApp("/tmp/Cowork.app", {
      logger: { log: (message) => logs.push(message) },
      runCommand: (command, args) => {
        calls.push([command, args]);
      },
    });

    expect(calls).toEqual([["xcrun", ["stapler", "staple", "/tmp/Cowork.app"]]]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("/tmp/Cowork.app");
  });

  test("propagates staple failures so the build fails loud", () => {
    expect(() =>
      stapleNotarizedApp("/tmp/Cowork.app", {
        logger: { log: () => {} },
        runCommand: () => {
          throw new Error("stapler staple failed");
        },
      }),
    ).toThrow("stapler staple failed");
  });
});
