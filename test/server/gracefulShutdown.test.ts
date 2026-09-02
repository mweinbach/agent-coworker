import { describe, expect, mock, test } from "bun:test";
import { once } from "node:events";
import { PassThrough } from "node:stream";

import {
  createGracefulShutdown,
  registerParentManagedShutdown,
} from "../../src/server/runtime/gracefulShutdown";

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

describe("parent-managed server shutdown", () => {
  test.each([undefined, "0", "true"])(
    "does not consume stdin without an exact opt-in flag (%s)",
    (flag) => {
      const stdin = new PassThrough();
      const onParentExit = mock(() => {});
      const dispose = registerParentManagedShutdown({
        env: { COWORK_DESKTOP_PARENT_MANAGED: flag },
        stdin,
        onParentExit,
      });

      expect(stdin.readableFlowing).toBeNull();
      expect(stdin.listenerCount("end")).toBe(0);
      expect(stdin.listenerCount("close")).toBe(0);
      expect(stdin.listenerCount("error")).toBe(0);
      stdin.write("standalone input");
      expect(stdin.read()?.toString()).toBe("standalone input");
      dispose();
      stdin.destroy();
      expect(onParentExit).not.toHaveBeenCalled();
    },
  );

  test("EOF joins the existing graceful shutdown once and waits for its drain", async () => {
    const stdin = new PassThrough();
    const env = { COWORK_DESKTOP_PARENT_MANAGED: "1" };
    const stopStarted = Promise.withResolvers<void>();
    const drain = Promise.withResolvers<void>();
    const stopServer = mock(async () => {
      stopStarted.resolve();
      await drain.promise;
    });
    const shutdownAnalytics = mock(async () => {});
    const exit = mock((_code: number) => {});
    const shutdown = createGracefulShutdown({ stopServer, shutdownAnalytics, exit });
    const onParentExit = mock(() => {
      void shutdown();
    });
    const dispose = registerParentManagedShutdown({ env, stdin, onParentExit });

    try {
      expect(env.COWORK_DESKTOP_PARENT_MANAGED).toBeUndefined();
      stdin.end();
      await stopStarted.promise;
      stdin.emit("close");
      stdin.emit("end");
      const signalShutdown = shutdown();

      expect(onParentExit).toHaveBeenCalledTimes(1);
      expect(stopServer).toHaveBeenCalledTimes(1);
      expect(shutdownAnalytics).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
      expect(stdin.listenerCount("end")).toBe(0);
      expect(stdin.listenerCount("close")).toBe(0);
      expect(stdin.listenerCount("error")).toBe(0);

      drain.resolve();
      await signalShutdown;
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      drain.resolve();
      await shutdown();
      dispose();
      stdin.destroy();
    }
  });

  test("captures parent EOF before the server finishes starting", async () => {
    const stdin = new PassThrough();
    const parent = new AbortController();
    const dispose = registerParentManagedShutdown({
      env: { COWORK_DESKTOP_PARENT_MANAGED: "1" },
      stdin,
      onParentExit: () => parent.abort(),
    });
    const ended = once(stdin, "end");
    stdin.end();
    await ended;

    expect(parent.signal.aborted).toBe(true);
    dispose();
  });

  test.each(["ended", "destroyed"] as const)(
    "detects a channel already %s before registration",
    async (state) => {
      const stdin = new PassThrough();
      if (state === "ended") {
        const ended = once(stdin, "end");
        stdin.resume();
        stdin.end();
        await ended;
      } else {
        stdin.destroy();
      }
      const onParentExit = mock(() => {});
      const dispose = registerParentManagedShutdown({
        env: { COWORK_DESKTOP_PARENT_MANAGED: "1" },
        stdin,
        onParentExit,
      });

      expect(onParentExit).toHaveBeenCalledTimes(1);
      expect(stdin.listenerCount("end")).toBe(0);
      expect(stdin.listenerCount("close")).toBe(0);
      expect(stdin.listenerCount("error")).toBe(0);
      dispose();
      stdin.destroy();
    },
  );

  test.each(["close", "error"] as const)("channel %s requests shutdown once", (event) => {
    const stdin = new PassThrough();
    const onParentExit = mock(() => {});
    const dispose = registerParentManagedShutdown({
      env: { COWORK_DESKTOP_PARENT_MANAGED: "1" },
      stdin,
      onParentExit,
    });

    stdin.emit(event, new Error("parent channel closed"));
    stdin.emit("end");
    expect(onParentExit).toHaveBeenCalledTimes(1);
    dispose();
    stdin.destroy();
  });

  test("disposal removes listeners and relinquishes stdin without shutting down", () => {
    const stdin = new PassThrough();
    const onParentExit = mock(() => {});
    const dispose = registerParentManagedShutdown({
      env: { COWORK_DESKTOP_PARENT_MANAGED: "1" },
      stdin,
      onParentExit,
    });

    dispose();
    dispose();
    expect(stdin.readableFlowing).toBe(false);
    expect(stdin.listenerCount("end")).toBe(0);
    expect(stdin.listenerCount("close")).toBe(0);
    expect(stdin.listenerCount("error")).toBe(0);
    stdin.emit("end");
    stdin.destroy();
    expect(onParentExit).not.toHaveBeenCalled();
  });
});
