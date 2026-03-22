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
    expect(calls.indexOf("stop:done")).toBeLessThan(calls.indexOf("quit"));
  });

  test("runs shutdown only once across repeated before-quit events", async () => {
    let resolveStop!: () => void;
    let stopCalls = 0;
    let quitCalls = 0;
    let preventCalls = 0;

    const stopPromise = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });

    const beforeQuit = createBeforeQuitHandler({
      stopAllServers: async () => {
        stopCalls += 1;
        await stopPromise;
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

    beforeQuit({
      preventDefault: () => {
        preventCalls += 1;
      },
    });

    expect(stopCalls).toBe(1);
    expect(quitCalls).toBe(0);
    expect(preventCalls).toBe(2);

    resolveStop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stopCalls).toBe(1);
    expect(quitCalls).toBe(1);
    expect(preventCalls).toBe(2);
  });

  test("still quits when stopAllServers fails", async () => {
    const calls: string[] = [];

    const beforeQuit = createBeforeQuitHandler({
      stopAllServers: async () => {
        calls.push("stop:start");
        throw new Error("boom");
      },
      quit: () => {
        calls.push("quit");
      },
      onError: (error) => {
        calls.push(`error:${error instanceof Error ? error.message : String(error)}`);
      },
    });

    beforeQuit({
      preventDefault: () => {
        calls.push("preventDefault");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toContain("preventDefault");
    expect(calls).toContain("stop:start");
    expect(calls).toContain("error:boom");
    expect(calls).toContain("quit");
  });
});
