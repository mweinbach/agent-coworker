import { describe, expect, test } from "bun:test";
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
  private destroyed = false;
  private closeListener: ((event: CloseEvent) => void) | null = null;
  private closedListener: (() => void) | null = null;

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
    if (!prevented) {
      this.destroyed = true;
      this.teardownCount += 1;
      this.closedListener?.();
    }
  }
}

describe("native window close coordinator", () => {
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
