import { describe, expect, test } from "bun:test";
import { createAppQuitHandlers } from "../electron/services/shutdown";
import { NativeWindowCloseCoordinator } from "../electron/services/windowCloseCoordinator";
import { DESKTOP_EVENT_CHANNELS } from "../src/lib/desktopApi";

type CloseEvent = {
  preventDefault(): void;
};

class FakeWindow {
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  readonly webContents = {
    id: 41,
    send: (channel: string, payload: unknown) => {
      this.sent.push({ channel, payload });
    },
  };
  teardownCount = 0;
  vetoNativeClose = false;
  private destroyed = false;
  private closeListener: ((event: CloseEvent) => void) | null = null;
  private closedListener: (() => void) | null = null;

  constructor(id = 41) {
    this.webContents.id = id;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  on(event: "close" | "closed", listener: (event?: CloseEvent) => void): void {
    if (event === "close") {
      this.closeListener = listener as (event: CloseEvent) => void;
    } else {
      this.closedListener = listener;
    }
  }

  off(event: "close" | "closed", listener: (event?: CloseEvent) => void): void {
    if (event === "close" && this.closeListener === listener) {
      this.closeListener = null;
    } else if (event === "closed" && this.closedListener === listener) {
      this.closedListener = null;
    }
  }

  close(): void {
    let prevented = false;
    this.closeListener?.({
      preventDefault() {
        prevented = true;
      },
    });
    if (!prevented && !this.vetoNativeClose) this.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.teardownCount += 1;
    this.closedListener?.();
  }
}

function createClosingApp(
  coordinator: NativeWindowCloseCoordinator,
  windows: FakeWindow[],
  calls: string[],
) {
  const handlers = createAppQuitHandlers({
    requestWindowClose: () => coordinator.prepareToQuit(),
    onQuitCancelled: () => coordinator.cancelQuit(),
    flushWindowState: async () => {
      calls.push("bounds");
    },
    stopAllServers: async () => {
      expect(windows.every((window) => window.isDestroyed())).toBe(true);
      calls.push("stop");
    },
    quit: () => {
      let prevented = false;
      const event = {
        preventDefault: () => {
          prevented = true;
        },
      };
      handlers.beforeQuit(event);
      if (prevented) return;
      for (const window of windows) {
        if (!window.isDestroyed()) window.close();
      }
      if (windows.some((window) => !window.isDestroyed())) {
        handlers.cancelQuit();
        return;
      }
      handlers.willQuit(event);
      if (!prevented) calls.push("quit");
    },
  });
  return handlers;
}

describe("native window close coordinator", () => {
  test("a native beforeunload veto preserves services and resets approval for retry", async () => {
    const window = new FakeWindow();
    window.vetoNativeClose = true;
    let requestId = 0;
    const coordinator = new NativeWindowCloseCoordinator({
      createRequestId: () => `close-${++requestId}`,
    });
    coordinator.track(window);
    const calls: string[] = [];
    const handlers = createClosingApp(coordinator, [window], calls);

    handlers.beforeQuit({ preventDefault() {} });
    coordinator.resolve(window.webContents, { requestId: "close-1", canClose: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.isDestroyed()).toBe(false);
    expect(calls).toEqual([]);

    window.vetoNativeClose = false;
    handlers.beforeQuit({ preventDefault() {} });
    expect(window.sent.at(-1)?.payload).toEqual({ requestId: "close-2" });
    coordinator.resolve(window.webContents, { requestId: "close-2", canClose: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["bounds", "stop", "quit"]);
  });

  test("cancelled approvals cannot relatch quit while a newer attempt is pending", async () => {
    const window = new FakeWindow();
    let requestId = 0;
    const coordinator = new NativeWindowCloseCoordinator({
      createRequestId: () => `close-${++requestId}`,
    });
    const untrack = coordinator.track(window);
    const cancelled = coordinator.prepareToQuit();
    coordinator.cancelQuit();
    const retry = coordinator.prepareToQuit();
    coordinator.resolve(window.webContents, { requestId: "close-1", canClose: true });
    expect(await cancelled).toBe(false);
    expect(window.sent).toHaveLength(2);
    coordinator.resolve(window.webContents, { requestId: "close-2", canClose: true });
    expect(await retry).toBe(true);
    coordinator.cancelQuit();
    window.close();
    expect(window.isDestroyed()).toBe(false);
    expect(window.sent.at(-1)?.payload).toEqual({ requestId: "close-3" });
    untrack();
  });

  test("explicit recovery approval can close a window whose beforeunload still vetoes", async () => {
    const window = new FakeWindow();
    window.vetoNativeClose = true;
    window.webContents.send = () => {
      throw new Error("renderer unresponsive");
    };
    const coordinator = new NativeWindowCloseCoordinator({
      confirmUnresponsiveClose: async () => true,
    });
    const untrack = coordinator.track(window);

    window.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.teardownCount).toBe(1);
    untrack();
  });

  test("ignores stale recovery confirmation after the renderer vetoes", async () => {
    const window = new FakeWindow();
    let confirm!: (approved: boolean) => void;
    const coordinator = new NativeWindowCloseCoordinator({
      createRequestId: () => "close-1",
      responseTimeoutMs: 1,
      confirmUnresponsiveClose: () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    });
    const untrack = coordinator.track(window);

    window.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    coordinator.resolve(window.webContents, { requestId: "close-1", canClose: false });
    confirm(true);
    await Promise.resolve();

    expect(window.isDestroyed()).toBe(false);
    untrack();
  });

  test("asks for final saves before shutdown and keeps services alive after a veto", async () => {
    const window = new FakeWindow();
    let requestId = 0;
    const coordinator = new NativeWindowCloseCoordinator({
      createRequestId: () => `close-${++requestId}`,
    });
    coordinator.track(window);
    const calls: string[] = [];
    const { beforeQuit } = createClosingApp(coordinator, [window], calls);

    beforeQuit({ preventDefault() {} });
    await Promise.resolve();
    expect(calls).toEqual([]);
    expect(window.sent.at(-1)?.payload).toEqual({ requestId: "close-1" });
    coordinator.resolve(window.webContents, { requestId: "close-1", canClose: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.isDestroyed()).toBe(false);
    expect(calls).toEqual([]);

    beforeQuit({ preventDefault() {} });
    await Promise.resolve();
    coordinator.resolve(window.webContents, { requestId: "close-2", canClose: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["bounds", "stop", "quit"]);
    expect(window.teardownCount).toBe(1);
    expect(window.sent).toHaveLength(2);
  });

  test("requires approval from every window without prematurely closing any", async () => {
    let requestId = 0;
    const coordinator = new NativeWindowCloseCoordinator({
      createRequestId: () => `close-${++requestId}`,
    });
    const first = new FakeWindow(1);
    const second = new FakeWindow(2);
    const untrackFirst = coordinator.track(first);
    const untrackSecond = coordinator.track(second);
    const approval = coordinator.prepareToQuit();
    coordinator.resolve(first.webContents, { requestId: "close-1", canClose: true });
    expect(first.isDestroyed()).toBe(false);
    coordinator.resolve(second.webContents, { requestId: "close-2", canClose: false });
    expect(await approval).toBe(false);
    expect(first.isDestroyed()).toBe(false);
    expect(second.isDestroyed()).toBe(false);
    untrackFirst();
    untrackSecond();
  });

  test("a save veto cancels other pending approvals without waiting for an unresponsive window", async () => {
    let requestId = 0;
    const coordinator = new NativeWindowCloseCoordinator({
      createRequestId: () => `close-${++requestId}`,
    });
    const first = new FakeWindow(1);
    const second = new FakeWindow(2);
    const untrackFirst = coordinator.track(first);
    const untrackSecond = coordinator.track(second);
    let decision: boolean | undefined;
    const approval = coordinator.prepareToQuit().then((allowed) => {
      decision = allowed;
    });
    try {
      coordinator.resolve(second.webContents, { requestId: "close-2", canClose: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(decision).toBe(false);
      coordinator.resolve(first.webContents, { requestId: "close-1", canClose: true });
      first.close();
      expect(first.isDestroyed()).toBe(false);
      expect(first.sent.at(-1)?.payload).toEqual({ requestId: "close-3" });
    } finally {
      untrackFirst();
      untrackSecond();
      await approval;
    }
  });

  test("offers recovery after an unanswered close and permits retry without discarding work", async () => {
    let requestId = 0;
    let recoveryCalls = 0;
    const window = new FakeWindow();
    const coordinator = new NativeWindowCloseCoordinator({
      createRequestId: () => `close-${++requestId}`,
      responseTimeoutMs: 1,
      confirmUnresponsiveClose: async () => {
        recoveryCalls += 1;
        return false;
      },
    });
    const untrack = coordinator.track(window);
    window.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(recoveryCalls).toBe(1);
    expect(window.isDestroyed()).toBe(false);

    window.close();
    expect(window.sent.at(-1)?.payload).toEqual({ requestId: "close-2" });
    coordinator.resolve(window.webContents, { requestId: "close-2", canClose: true });
    await Promise.resolve();
    expect(window.isDestroyed()).toBe(true);
    untrack();
  });

  test("a failed renderer send requires explicit recovery approval", async () => {
    const window = new FakeWindow();
    window.webContents.send = () => {
      throw new Error("renderer gone");
    };
    let recoveryCalls = 0;
    const coordinator = new NativeWindowCloseCoordinator({
      confirmUnresponsiveClose: async () => {
        recoveryCalls += 1;
        return true;
      },
    });
    coordinator.track(window);

    window.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recoveryCalls).toBe(1);
    expect(window.teardownCount).toBe(1);
  });

  test("defers teardown until the renderer reports its final save succeeded", () => {
    const window = new FakeWindow();
    const coordinator = new NativeWindowCloseCoordinator({
      createRequestId: () => "close-1",
    });
    coordinator.track(window);

    window.close();

    expect(window.teardownCount).toBe(0);
    expect(window.sent).toEqual([
      {
        channel: DESKTOP_EVENT_CHANNELS.windowCloseRequested,
        payload: { requestId: "close-1" },
      },
    ]);

    coordinator.resolve(window.webContents, {
      requestId: "close-1",
      canClose: true,
    });

    expect(window.teardownCount).toBe(1);
  });

  test("keeps the window alive after a failed final save so recovery remains visible", () => {
    let requestId = 0;
    const window = new FakeWindow();
    const coordinator = new NativeWindowCloseCoordinator({
      createRequestId: () => `close-${++requestId}`,
    });
    coordinator.track(window);

    window.close();
    coordinator.resolve(window.webContents, {
      requestId: "close-1",
      canClose: false,
    });

    expect(window.teardownCount).toBe(0);
    expect(window.isDestroyed()).toBe(false);

    window.close();
    expect(window.sent.at(-1)?.payload).toEqual({ requestId: "close-2" });
  });
});
