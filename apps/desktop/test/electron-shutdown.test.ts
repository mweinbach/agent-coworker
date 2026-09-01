import { describe, expect, test } from "bun:test";

import { createAppQuitHandlers } from "../electron/services/shutdown";

function createImmediatelyClosingApp(deps: Parameters<typeof createAppQuitHandlers>[0]) {
  const handlers = createAppQuitHandlers({
    ...deps,
    quit: () => {
      let prevented = false;
      const event = {
        preventDefault: () => {
          prevented = true;
        },
      };
      handlers.beforeQuit(event);
      if (prevented) return;
      handlers.willQuit(event);
      if (!prevented) deps.quit();
    },
  });
  return handlers;
}

describe("desktop shutdown handler", () => {
  test("defers a native update installer until windows close and server cleanup completes", async () => {
    let approve!: (allowed: boolean) => void;
    let finishStop!: () => void;
    const stopping = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const calls: string[] = [];
    const handlers = createImmediatelyClosingApp({
      requestWindowClose: () =>
        new Promise((resolve) => {
          calls.push("approval");
          approve = resolve;
        }),
      onCloseWindows: () => calls.push("closing"),
      stopAllServers: async () => {
        calls.push("stop:start");
        await stopping;
        calls.push("stop:done");
      },
      quit: () => calls.push("quit"),
    });

    const install = () => calls.push("install");
    handlers.requestQuit(install);
    handlers.requestQuit(install);
    expect(calls).toEqual(["approval"]);
    approve(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["approval", "closing", "stop:start"]);
    finishStop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["approval", "closing", "stop:start", "stop:done", "install"]);
  });

  test("discarded update-quit intent is not replayed on a later ordinary quit", async () => {
    let canClose = false;
    const calls: string[] = [];
    const handlers = createImmediatelyClosingApp({
      requestWindowClose: async () => canClose,
      stopAllServers: async () => {
        calls.push("stop");
      },
      quit: () => calls.push("quit"),
    });

    handlers.requestQuit(() => calls.push("install"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
    canClose = true;
    handlers.beforeQuit({ preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["stop", "quit"]);
  });

  test("still exits after completed teardown if the native installer throws", async () => {
    const calls: string[] = [];
    const handlers = createImmediatelyClosingApp({
      stopAllServers: async () => {
        calls.push("stop");
      },
      quit: () => calls.push("quit"),
      onError: () => calls.push("error"),
    });
    handlers.requestQuit(() => {
      calls.push("install");
      throw new Error("installer unavailable");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["stop", "install", "error", "quit"]);
  });

  test("exits once when the native installer later reports failure without throwing", async () => {
    const calls: string[] = [];
    let failInstall!: () => void;
    const handlers = createImmediatelyClosingApp({
      stopAllServers: async () => {
        calls.push("stop");
      },
      quit: () => calls.push("quit"),
    });
    handlers.requestQuit((onFailure) => {
      calls.push("install");
      failInstall = onFailure;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["stop", "install"]);
    expect(failInstall).toBeFunction();
    failInstall();
    failInstall();
    expect(calls).toEqual(["stop", "install", "quit"]);
  });

  test("keeps services alive until native windows have actually closed", async () => {
    const calls: string[] = [];
    const { beforeQuit, willQuit } = createAppQuitHandlers({
      onQuitRequested: () => calls.push("requested"),
      requestWindowClose: async () => true,
      onShutdownStarted: () => calls.push("approved"),
      stopAllServers: async () => {
        calls.push("stop");
      },
      quit: () => calls.push("native-close"),
    });

    beforeQuit({ preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Electron may still receive a beforeunload veto after custom preflight.
    expect(calls).toEqual(["requested", "native-close"]);

    willQuit({ preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["requested", "native-close", "approved", "stop", "native-close"]);
  });

  test("invalidates cancelled preflight results without cancelling a newer attempt", async () => {
    const approvals: Array<(approved: boolean) => void> = [];
    const calls: string[] = [];
    const handlers = createAppQuitHandlers({
      requestWindowClose: () => new Promise((resolve) => approvals.push(resolve)),
      onQuitCancelled: () => calls.push("cancel"),
      stopAllServers: async () => {
        calls.push("stop");
      },
      quit: () => calls.push("native-close"),
    });
    const event = { preventDefault() {} };

    handlers.beforeQuit(event);
    handlers.cancelQuit();
    handlers.beforeQuit(event);
    approvals[0]!(true);
    await Promise.resolve();
    expect(calls).toEqual(["cancel"]);

    approvals[1]!(true);
    await Promise.resolve();
    expect(calls).toEqual(["cancel", "native-close"]);
  });

  test("preserves services until close approval and permits retry after a veto", async () => {
    let resolveApproval!: (approved: boolean) => void;
    const calls: string[] = [];
    const { beforeQuit } = createImmediatelyClosingApp({
      requestWindowClose: () =>
        new Promise<boolean>((resolve) => {
          calls.push("approval");
          resolveApproval = resolve;
        }),
      flushWindowState: async () => {
        calls.push("bounds");
      },
      stopAllServers: async () => {
        calls.push("stop");
      },
      quit: () => {
        calls.push("quit");
      },
    });
    const event = { preventDefault() {} };

    beforeQuit(event);
    expect(calls).toEqual(["approval"]);
    resolveApproval(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["approval"]);

    beforeQuit(event);
    resolveApproval(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["approval", "approval", "bounds", "stop", "quit"]);
  });

  for (const callback of [
    "unregisterAppearanceListener",
    "stopUpdater",
    "stopQuickChat",
  ] as const) {
    test(`still finishes shutdown when ${callback} and error reporting throw`, async () => {
      const calls: string[] = [];
      const { beforeQuit } = createImmediatelyClosingApp({
        [callback]: () => {
          throw new Error("cleanup failed");
        },
        stopAllServers: async () => {
          calls.push("stop");
        },
        stopProductAnalytics: async () => {
          calls.push("analytics");
        },
        quit: () => {
          calls.push("quit");
        },
        onError: () => {
          throw new Error("report failed");
        },
      });

      beforeQuit({ preventDefault() {} });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toEqual(["stop", "analytics", "quit"]);
    });
  }

  test("waits for server shutdown before quitting", async () => {
    let resolveStop!: () => void;
    const calls: string[] = [];

    const stopPromise = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });

    const { beforeQuit } = createImmediatelyClosingApp({
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

    const { beforeQuit } = createImmediatelyClosingApp({
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

  test("still stops the mobile relay bridge when stopAllServers fails", async () => {
    const calls: string[] = [];

    const { beforeQuit } = createImmediatelyClosingApp({
      stopAllServers: async () => {
        calls.push("stop:start");
        throw new Error("boom");
      },
      stopMobileRelayBridge: async () => {
        calls.push("relay:stop");
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
    expect(calls).toContain("relay:stop");
    expect(calls).toContain("stop:start");
    expect(calls).toContain("error:boom");
    expect(calls).toContain("quit");
    expect(calls.indexOf("relay:stop")).toBeLessThan(calls.indexOf("stop:start"));
    expect(calls.indexOf("stop:start")).toBeLessThan(calls.indexOf("error:boom"));
    expect(calls.indexOf("relay:stop")).toBeLessThan(calls.indexOf("quit"));
  });
});
