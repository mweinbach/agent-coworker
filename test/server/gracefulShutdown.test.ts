import { describe, expect, test } from "bun:test";

import { createGracefulShutdown } from "../../src/server/runtime/gracefulShutdown";

describe("graceful server shutdown", () => {
  test("does not exit before server persistence and analytics have drained", async () => {
    let releaseServer: () => void = () => undefined;
    let releaseAnalytics: () => void = () => undefined;
    const serverStopped = new Promise<void>((resolve) => {
      releaseServer = resolve;
    });
    const analyticsStopped = new Promise<void>((resolve) => {
      releaseAnalytics = resolve;
    });
    const exits: number[] = [];
    const shutdown = createGracefulShutdown({
      stopServer: () => serverStopped,
      shutdownAnalytics: () => analyticsStopped,
      exit: (code) => {
        exits.push(code);
      },
    });

    const pending = shutdown();
    await Promise.resolve();
    expect(exits).toEqual([]);

    releaseServer();
    await Promise.resolve();
    expect(exits).toEqual([]);

    releaseAnalytics();
    await pending;
    expect(exits).toEqual([0]);
  });

  test("runs cleanup and exits exactly once when multiple signals arrive", async () => {
    let stopCount = 0;
    let analyticsCount = 0;
    const exits: number[] = [];
    const shutdown = createGracefulShutdown({
      stopServer: async () => {
        stopCount += 1;
      },
      shutdownAnalytics: async () => {
        analyticsCount += 1;
      },
      exit: (code) => {
        exits.push(code);
      },
    });

    await Promise.all([shutdown(), shutdown(), shutdown()]);

    expect(stopCount).toBe(1);
    expect(analyticsCount).toBe(1);
    expect(exits).toEqual([0]);
  });

  test("still drains the server when analytics shutdown fails", async () => {
    let stopped = false;
    const exits: number[] = [];
    const shutdown = createGracefulShutdown({
      stopServer: async () => {
        stopped = true;
      },
      shutdownAnalytics: async () => {
        throw new Error("analytics unavailable");
      },
      exit: (code) => {
        exits.push(code);
      },
    });

    await shutdown();

    expect(stopped).toBe(true);
    expect(exits).toEqual([0]);
  });

  test("bounds a stuck shutdown and never exits twice when it eventually settles", async () => {
    let releaseServer: () => void = () => undefined;
    const serverStopped = new Promise<void>((resolve) => {
      releaseServer = resolve;
    });
    const exits: number[] = [];
    const shutdown = createGracefulShutdown({
      stopServer: () => serverStopped,
      shutdownAnalytics: async () => {},
      exit: (code) => {
        exits.push(code);
      },
      timeoutMs: 5,
    });

    const pending = shutdown();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(exits).toEqual([0]);

    releaseServer();
    await pending;
    expect(exits).toEqual([0]);
  });
});
