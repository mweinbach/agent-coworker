import { afterEach, describe, expect, test } from "bun:test";

import {
  getDesktopWindowMode,
  getDesktopWindowThreadId,
  shouldStartNewQuickChatThread,
} from "../src/lib/windowMode";

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

function restoreWindow() {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, "window");
}

function installWindowWithSearch(search: string) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        search,
      },
    },
  });
}

function installWindowWithThrowingLocation() {
  const mockWindow = {};
  Object.defineProperty(mockWindow, "location", {
    configurable: true,
    get() {
      throw new TypeError("window is closed");
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: mockWindow,
  });
}

afterEach(() => {
  restoreWindow();
});

describe("desktop window mode parsing", () => {
  test("parses supported window mode query params", () => {
    installWindowWithSearch("?window=quick-chat&threadId=thread-1&newThread=true");

    expect(getDesktopWindowMode()).toBe("quick-chat");
    expect(getDesktopWindowThreadId()).toBe("thread-1");
    expect(shouldStartNewQuickChatThread()).toBe(true);
  });

  test("falls back to main mode when window location is unavailable", () => {
    installWindowWithThrowingLocation();

    expect(getDesktopWindowMode()).toBe("main");
    expect(getDesktopWindowThreadId()).toBeNull();
    expect(shouldStartNewQuickChatThread()).toBe(false);
  });
});
