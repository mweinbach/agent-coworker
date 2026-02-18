import { describe, expect, test } from "bun:test";

import { createBeforeQuitHandler } from "../electron/services/shutdown";

describe("desktop shutdown handler", () => {
  test("waits for server shutdown before quitting", async () => {
    let resolveStop!: () => void;
    const calls: string[] = [];

    const stopPromise = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });

    const beforeQuit = createBeforeQuitHandler({
      unregisterIpc: () => {
        calls.push("unregister");
      },
      stopAllServers: async () => {
        calls.push("stop:start");
        await stopPromise;
        calls.push("stop:done");
      },
      quit: () => {
        calls.push("quit");
      },
    });

    beforeQuit({
      preventDefault: () => {
        calls.push("preventDefault");
      },
    });

    expect(calls).toContain("preventDefault");
    expect(calls).toContain("stop:start");
    expect(calls).not.toContain("quit");

    resolveStop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toContain("stop:done");
    expect(calls).toContain("quit");
  });

  test("runs shutdown only once across repeated before-quit events", async () => {
    let stopCalls = 0;
    let quitCalls = 0;
    let preventCalls = 0;

    const beforeQuit = createBeforeQuitHandler({
      unregisterIpc: () => {},
      stopAllServers: async () => {
        stopCalls += 1;
      },
      quit: () => {
        quitCalls += 1;
      },
    });

    beforeQuit({
      preventDefault: () => {
        preventCalls += 1;
      },
    });
    await Promise.resolve();

    beforeQuit({
      preventDefault: () => {
        preventCalls += 1;
      },
    });
    await Promise.resolve();

    expect(stopCalls).toBe(1);
    expect(quitCalls).toBe(1);
    expect(preventCalls).toBe(1);
  });
});
