import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { OperationState } from "../src/app/types";
import { ConnectionRecoveryBanner } from "../src/ui/ConnectionRecoveryBanner";
import { setupJsdom } from "./jsdomHarness";

describe("ConnectionRecoveryBanner", () => {
  let harness: ReturnType<typeof setupJsdom>;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    harness = setupJsdom();
    container = harness.dom.window.document.getElementById("root") as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    harness.restore();
  });

  test("keeps loss, progress, and success visible until success is dismissed", () => {
    const reconnect = async () => {};
    act(() => {
      root.render(
        createElement(ConnectionRecoveryBanner, {
          disconnected: true,
          operation: undefined,
          reconnect,
        }),
      );
    });
    expect(container.textContent).toContain(
      "Connection lost. Your draft is safe; reconnect to continue.",
    );

    const pending: OperationState = {
      status: "pending",
      key: "thread-reconnect:thread-1",
      label: "Reconnect chat",
      startedAt: "2026-07-11T12:00:00.000Z",
      error: null,
    };
    act(() => {
      root.render(
        createElement(ConnectionRecoveryBanner, {
          disconnected: false,
          operation: pending,
          reconnect,
        }),
      );
    });
    expect(container.textContent).toContain("Reconnecting this chat… Your draft is safe.");

    const success: OperationState = {
      ...pending,
      status: "success",
      finishedAt: "2026-07-11T12:00:01.000Z",
    };
    act(() => {
      root.render(
        createElement(ConnectionRecoveryBanner, {
          disconnected: false,
          operation: success,
          reconnect,
        }),
      );
    });
    expect(container.textContent).toContain("Reconnected. Your draft and conversation are intact.");

    const dismiss = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss connection status"]',
    );
    expect(dismiss).not.toBeNull();
    act(() => {
      dismiss?.click();
    });
    expect(container.querySelector('[data-slot="connection-banner"]')).toBeNull();
  });

  test("keeps a failed reconnect actionable", () => {
    const operation: OperationState = {
      status: "error",
      key: "thread-reconnect:thread-1",
      label: "Reconnect chat",
      startedAt: "2026-07-11T12:00:00.000Z",
      finishedAt: "2026-07-11T12:00:01.000Z",
      error: {
        code: "request_failed",
        message: "Cowork could not reconnect this chat.",
        retryable: true,
        repairAction: "Your draft is safe. Retry.",
      },
    };
    act(() => {
      root.render(
        createElement(ConnectionRecoveryBanner, {
          disconnected: true,
          operation,
          reconnect: async () => {},
        }),
      );
    });

    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain("Cowork could not reconnect this chat.");
    expect(container.textContent).toContain("Your draft is safe. Retry.");
    expect(container.textContent).toContain("Retry");
  });

  test("does not let an earlier success hide a later disconnect", () => {
    const operation: OperationState = {
      status: "success",
      key: "thread-reconnect:thread-1",
      label: "Reconnect chat",
      startedAt: "2026-07-11T12:00:00.000Z",
      finishedAt: "2026-07-11T12:00:01.000Z",
      error: null,
    };
    act(() => {
      root.render(
        createElement(ConnectionRecoveryBanner, {
          disconnected: true,
          operation,
          reconnect: async () => {},
        }),
      );
    });

    expect(container.textContent).toContain(
      "Connection lost. Your draft is safe; reconnect to continue.",
    );
    expect(container.textContent).not.toContain(
      "Reconnected. Your draft and conversation are intact.",
    );
  });
});
