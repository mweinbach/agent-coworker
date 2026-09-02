import { describe, expect, mock, test } from "bun:test";

import {
  createSingleWindowOpener,
  loadCreatedWindow,
  revealAndActivateWindow,
} from "../electron/services/windowActivation";

describe("window activation", () => {
  test("shares main-window creation while loading and retries after a failed load", async () => {
    let release!: () => void;
    const loading = new Promise<void>((resolve) => {
      release = resolve;
    });
    const window = { isDestroyed: () => false };
    let current: typeof window | null = null;
    const createWindow = mock(async () => {
      await loading;
      current = window;
      return window;
    });
    const open = createSingleWindowOpener(() => current, createWindow);
    const first = open();
    const second = open();
    release();

    expect(await first).toBe(window);
    expect(await second).toBe(window);
    expect(await open()).toBe(window);
    expect(createWindow).toHaveBeenCalledTimes(1);

    const retryCreate = mock(async () => window);
    retryCreate.mockImplementationOnce(async () => {
      throw new Error("load failed");
    });
    const retryOpen = createSingleWindowOpener(() => null, retryCreate);
    await expect(retryOpen()).rejects.toThrow("load failed");
    expect(await retryOpen()).toBe(window);
    expect(retryCreate).toHaveBeenCalledTimes(2);
  });

  test("destroys an owned window when its initial renderer load fails", async () => {
    const window = { isDestroyed: () => false, destroy: mock() };
    await expect(
      loadCreatedWindow(window, async () => {
        throw new Error("renderer unavailable");
      }),
    ).rejects.toThrow("renderer unavailable");
    expect(window.destroy).toHaveBeenCalledTimes(1);
  });

  test("activates and reveals windows on macOS launch", () => {
    const calls: string[] = [];
    const app = {
      focus: mock((options?: { steal?: boolean }) => {
        calls.push(`app.focus:${String(options?.steal ?? false)}`);
      }),
      isHidden: mock(() => true),
      show: mock(() => {
        calls.push("app.show");
      }),
    };
    const win = {
      isMinimized: mock(() => true),
      restore: mock(() => {
        calls.push("win.restore");
      }),
      show: mock(() => {
        calls.push("win.show");
      }),
      focus: mock(() => {
        calls.push("win.focus");
      }),
    };

    revealAndActivateWindow(app, win, "darwin");

    expect(calls).toEqual(["win.restore", "app.show", "app.focus:true", "win.show", "win.focus"]);
  });

  test("focuses the app without macOS-specific activation options elsewhere", () => {
    const app = {
      focus: mock(),
    };
    const win = {
      isMinimized: mock(() => false),
      restore: mock(),
      show: mock(),
      focus: mock(),
    };

    revealAndActivateWindow(app, win, "linux");

    expect(app.focus).toHaveBeenCalledWith();
    expect(win.restore).not.toHaveBeenCalled();
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });
});
