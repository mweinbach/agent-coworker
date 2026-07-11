import { describe, expect, mock, test } from "bun:test";

import { DocumentThemeStore } from "../src/lib/documentThemeStore";
import { setupJsdom } from "./jsdomHarness";

describe("DocumentThemeStore", () => {
  test.serial("shares one MutationObserver across all active markdown subscribers", () => {
    const harness = setupJsdom();
    const previousMutationObserver = globalThis.MutationObserver;
    let callback: MutationCallback | null = null;
    let observerCount = 0;
    let disconnectCount = 0;

    class CountingMutationObserver {
      constructor(nextCallback: MutationCallback) {
        callback = nextCallback;
        observerCount += 1;
      }

      observe(): void {}

      disconnect(): void {
        disconnectCount += 1;
      }

      takeRecords(): MutationRecord[] {
        return [];
      }
    }

    Object.defineProperty(globalThis, "MutationObserver", {
      configurable: true,
      value: CountingMutationObserver,
    });

    try {
      const store = new DocumentThemeStore();
      const firstListener = mock(() => {});
      const secondListener = mock(() => {});
      const unsubscribeFirst = store.subscribe(firstListener);
      const unsubscribeSecond = store.subscribe(secondListener);

      expect(observerCount).toBe(1);
      expect(store.getSnapshot()).toBe(false);

      harness.dom.window.document.documentElement.classList.add("dark");
      callback?.([], {} as MutationObserver);
      expect(store.getSnapshot()).toBe(true);
      expect(firstListener).toHaveBeenCalledTimes(1);
      expect(secondListener).toHaveBeenCalledTimes(1);

      unsubscribeFirst();
      expect(disconnectCount).toBe(0);
      unsubscribeSecond();
      expect(disconnectCount).toBe(1);
    } finally {
      Object.defineProperty(globalThis, "MutationObserver", {
        configurable: true,
        value: previousMutationObserver,
      });
      harness.restore();
    }
  });
});
