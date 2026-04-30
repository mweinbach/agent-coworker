import { describe, expect, mock, test } from "bun:test";

import { revealAndActivateWindow } from "../electron/services/windowActivation";

describe("window activation", () => {
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
