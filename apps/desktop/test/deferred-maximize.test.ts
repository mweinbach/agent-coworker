import { describe, expect, mock, test } from "bun:test";

import { createDeferredMaximize } from "../electron/services/deferredMaximize";

function fakeWindow() {
  let destroyed = false;
  const maximize = mock(() => {});
  return {
    maximize,
    setDestroyed(next: boolean) {
      destroyed = next;
    },
    win: {
      isDestroyed: () => destroyed,
      maximize,
    },
  };
}

describe("deferred restored maximize", () => {
  test("does not maximize a window that was not restored maximized", () => {
    const window = fakeWindow();
    const apply = createDeferredMaximize(false);

    apply(window.win);
    apply(window.win);

    expect(window.maximize).not.toHaveBeenCalled();
  });

  test("maximizes once on the first live reveal", () => {
    const window = fakeWindow();
    const apply = createDeferredMaximize(true);

    apply(window.win);
    apply(window.win);

    expect(window.maximize).toHaveBeenCalledTimes(1);
  });

  test("a destroyed window does not consume the restored maximize", () => {
    const window = fakeWindow();
    window.setDestroyed(true);
    const apply = createDeferredMaximize(true);

    apply(window.win);
    expect(window.maximize).not.toHaveBeenCalled();

    window.setDestroyed(false);
    apply(window.win);
    apply(window.win);

    expect(window.maximize).toHaveBeenCalledTimes(1);
  });
});
