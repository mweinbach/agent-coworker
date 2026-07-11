import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock());
mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: NoopJsonRpcSocket,
}));

const { useAppStore } = await import("../src/app/store");
const { InAppToasts } = await import("../src/ui/InAppToasts");
const { OperationFeedback } = await import("../src/ui/OperationFeedback");
const defaultStoreState = useAppStore.getState();

afterEach(() => {
  useAppStore.setState(defaultStoreState);
});

describe("foreground operation feedback accessibility", () => {
  test("announces pending and failed operations without moving focus", async () => {
    const harness = setupJsdom();
    const focusTarget = harness.dom.window.document.createElement("input");
    harness.dom.window.document.body.append(focusTarget);
    focusTarget.focus();
    const container = harness.dom.window.document.getElementById("root");
    if (!container) throw new Error("missing root");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(OperationFeedback, {
            operation: {
              status: "pending",
              key: "memory:save",
              label: "Save memory",
              startedAt: "2026-07-11T00:00:00.000Z",
              error: null,
            },
          }),
        );
      });

      const pending = container.querySelector('[role="status"]');
      expect(pending?.getAttribute("aria-live")).toBe("polite");
      expect(pending?.getAttribute("aria-atomic")).toBe("true");
      expect(container.textContent).toContain("Save memory");
      expect(harness.dom.window.document.activeElement).toBe(focusTarget);

      await act(async () => {
        root.render(
          createElement(OperationFeedback, {
            operation: {
              status: "error",
              key: "memory:save",
              label: "Save memory",
              startedAt: "2026-07-11T00:00:00.000Z",
              finishedAt: "2026-07-11T00:00:01.000Z",
              error: {
                code: "request_failed",
                message: "The memory could not be saved.",
                retryable: true,
                repairAction: "Check the connection and retry.",
              },
            },
          }),
        );
      });

      const failure = container.querySelector('[role="alert"]');
      expect(failure?.getAttribute("aria-live")).toBe("assertive");
      expect(failure?.getAttribute("aria-atomic")).toBe("true");
      expect(container.textContent).toContain("The memory could not be saved.");
      expect(container.textContent).toContain("Check the connection and retry.");
      expect(harness.dom.window.document.activeElement).toBe(focusTarget);
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });

  test("renders keyboard-dismissible in-app alerts without stealing focus", async () => {
    const harness = setupJsdom();
    const focusTarget = harness.dom.window.document.createElement("input");
    harness.dom.window.document.body.append(focusTarget);
    focusTarget.focus();
    const container = harness.dom.window.document.getElementById("root");
    if (!container) throw new Error("missing root");
    const root = createRoot(container);

    try {
      useAppStore.setState({
        notifications: [
          {
            id: "foreground-failure",
            ts: "2026-07-11T00:00:00.000Z",
            kind: "error",
            title: "Memory not saved",
            detail: "The draft remains open.",
            audience: "foreground",
          },
        ],
      });

      await act(async () => {
        root.render(createElement(InAppToasts));
      });

      const alert = container.querySelector('[role="alert"]');
      const dismiss = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Dismiss notification"]',
      );
      expect(alert?.getAttribute("aria-live")).toBe("assertive");
      expect(alert?.getAttribute("aria-atomic")).toBe("true");
      expect(dismiss).not.toBeNull();
      expect(harness.dom.window.document.activeElement).toBe(focusTarget);

      await act(async () => {
        dismiss?.click();
      });
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });
});
