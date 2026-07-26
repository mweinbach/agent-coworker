import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import type { Notification } from "../src/app/types";
import { DESKTOP_API_OVERRIDE_KEY } from "../src/lib/desktopApiOverride";
import { installDesktopCommandsBridge } from "./helpers/desktopCommandsBridge";
import {
  clearJsonRpcSocketOverride,
  NoopJsonRpcSocket,
  setJsonRpcSocketOverride,
} from "./helpers/jsonRpcSocketMock";
import { createDesktopApiMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

installDesktopCommandsBridge();

const desktopApiMock = createDesktopApiMock();

const { useAppStore } = await import("../src/app/store");
const { runAcknowledgedOperation } = await import("../src/app/store.helpers/operations");
const { InAppToasts } = await import("../src/ui/InAppToasts");
const { OperationFeedback } = await import("../src/ui/OperationFeedback");
const defaultStoreState = useAppStore.getState();

const OPERATION_KEY = "memory:save:workspace";

beforeEach(() => {
  (globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY] = desktopApiMock;
  setJsonRpcSocketOverride(NoopJsonRpcSocket);
  useAppStore.setState({ notifications: [], operationsByKey: {} });
});

afterEach(() => {
  useAppStore.setState(defaultStoreState);
  clearJsonRpcSocketOverride();
  delete (globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY];
});

function InlineOperationFeedback({ operationKey }: { operationKey: string }) {
  const operation = useAppStore((s) => s.operationsByKey?.[operationKey]);
  return createElement(OperationFeedback, { operation });
}

async function failOperation(audience?: "foreground" | "background") {
  await act(async () => {
    await runAcknowledgedOperation(useAppStore.getState as never, useAppStore.setState as never, {
      key: OPERATION_KEY,
      label: "Save memory",
      errorTitle: "Memory not saved",
      errorMessage: "Unable to save memory.",
      repairAction: "Check the connection and retry.",
      ...(audience ? { audience } : {}),
      execute: async () => {
        throw new Error("Server rejected the update.");
      },
    });
  });
}

function seedNotifications(entries: Notification[]) {
  useAppStore.setState({ notifications: entries });
}

describe("acknowledged operation failure routing", () => {
  test("tags the published failure with its operation key and audience", async () => {
    await failOperation();
    expect(useAppStore.getState().notifications.at(-1)).toMatchObject({
      kind: "error",
      title: "Memory not saved",
      audience: "foreground",
      operationKey: OPERATION_KEY,
    });

    useAppStore.setState({ notifications: [], operationsByKey: {} });

    await failOperation("background");
    expect(useAppStore.getState().notifications.at(-1)).toMatchObject({
      audience: "background",
      operationKey: OPERATION_KEY,
    });
  });

  test("reports a foreground failure inline only, never also as a toast", async () => {
    const harness = setupJsdom();
    const container = harness.dom.window.document.getElementById("root");
    if (!container) throw new Error("missing root");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(
            Fragment,
            null,
            createElement(InlineOperationFeedback, { operationKey: OPERATION_KEY }),
            createElement(InAppToasts),
          ),
        );
      });

      await failOperation();

      expect(container.querySelectorAll('[data-slot="in-app-toast"]')).toHaveLength(0);
      const inline = container.querySelector('[data-operation-feedback="error"]');
      expect(inline?.getAttribute("aria-live")).toBe("assertive");
      expect(inline?.textContent).toContain("Server rejected the update.");
      expect(inline?.textContent).toContain("Check the connection and retry.");
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });

  test("escalates to a toast when no inline surface owns the operation", async () => {
    const harness = setupJsdom();
    const container = harness.dom.window.document.getElementById("root");
    if (!container) throw new Error("missing root");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(InAppToasts));
      });

      await failOperation();

      const toasts = container.querySelectorAll('[data-slot="in-app-toast"]');
      expect(toasts).toHaveLength(1);
      expect(toasts[0]?.textContent).toContain("Memory not saved");
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });

  test("a background operation still toasts even with its inline surface mounted", async () => {
    const harness = setupJsdom();
    const container = harness.dom.window.document.getElementById("root");
    if (!container) throw new Error("missing root");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(
            Fragment,
            null,
            createElement(InlineOperationFeedback, { operationKey: OPERATION_KEY }),
            createElement(InAppToasts),
          ),
        );
      });

      await failOperation("background");

      expect(container.querySelector('[data-operation-feedback="error"]')).not.toBeNull();
      expect(container.querySelectorAll('[data-slot="in-app-toast"]')).toHaveLength(1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });
});

describe("in-app toast lifetime and overflow", () => {
  test("transient outcomes expire while failures persist until dismissed", async () => {
    const harness = setupJsdom();
    const container = harness.dom.window.document.getElementById("root");
    if (!container) throw new Error("missing root");
    const root = createRoot(container);

    try {
      seedNotifications([
        {
          id: "info-1",
          ts: "2026-07-11T00:00:00.000Z",
          kind: "info",
          title: "Provider connected",
        },
        {
          id: "error-1",
          ts: "2026-07-11T00:00:01.000Z",
          kind: "error",
          title: "Transcript sync needs attention",
        },
      ]);

      await act(async () => {
        root.render(createElement(InAppToasts, { autoDismissMs: 20 }));
      });

      expect(container.querySelectorAll('[data-slot="in-app-toast"]')).toHaveLength(2);
      expect(container.querySelector('[data-kind="info"]')).not.toBeNull();
      expect(container.querySelector('[data-kind="error"]')).not.toBeNull();

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
      });

      expect(container.querySelector('[data-kind="info"]')).toBeNull();
      const survivor = container.querySelector('[data-kind="error"]');
      expect(survivor).not.toBeNull();
      expect(survivor?.getAttribute("role")).toBe("alert");
      expect(survivor?.getAttribute("aria-live")).toBe("assertive");
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });

  test("overflow is queued in arrival order instead of silently dropped", async () => {
    const harness = setupJsdom();
    const container = harness.dom.window.document.getElementById("root");
    if (!container) throw new Error("missing root");
    const root = createRoot(container);

    try {
      seedNotifications(
        Array.from({ length: 5 }, (_, index) => ({
          id: `error-${index + 1}`,
          ts: `2026-07-11T00:00:0${index}.000Z`,
          kind: "error" as const,
          title: `Failure ${index + 1}`,
        })),
      );

      await act(async () => {
        root.render(createElement(InAppToasts));
      });

      const titlesOf = () =>
        [...container.querySelectorAll('[data-slot="in-app-toast"]')].map(
          (node) => node.textContent?.match(/Failure \d/)?.[0],
        );

      expect(titlesOf()).toEqual(["Failure 1", "Failure 2", "Failure 3"]);
      expect(container.querySelector('[data-slot="in-app-toast-queue"]')?.textContent).toBe(
        "2 more waiting",
      );

      const dismiss = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Dismiss notification"]',
      );
      await act(async () => {
        dismiss?.click();
      });

      expect(titlesOf()).toEqual(["Failure 2", "Failure 3", "Failure 4"]);
      expect(container.querySelector('[data-slot="in-app-toast-queue"]')?.textContent).toBe(
        "1 more waiting",
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });
});
