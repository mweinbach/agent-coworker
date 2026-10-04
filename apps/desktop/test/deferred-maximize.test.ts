import { describe, expect, mock, test } from "bun:test";

import { createDeferredMaximize } from "../electron/services/deferredMaximize";

function fakeWindow(destroyed = false) {
  const maximize = mock(() => {});
  return {
    maximize,
    setDestroyed(next: boolean) {
      destroyed = next;
    },
    win: { isDestroyed: () => destroyed, maximize },
  };
}

describe("deferred restored maximize", () => {
  test("maximizes at most once on the first live reveal when restore is enabled", () => {
    const unmaximized = fakeWindow();
    const skip = createDeferredMaximize(false);
    skip(unmaximized.win);
    expect(unmaximized.maximize).not.toHaveBeenCalled();

    const window = fakeWindow(true);
    const apply = createDeferredMaximize(true);
    apply(window.win);
    expect(window.maximize).not.toHaveBeenCalled();

    window.setDestroyed(false);
    apply(window.win);
    apply(window.win);
    expect(window.maximize).toHaveBeenCalledTimes(1);
  });
});
