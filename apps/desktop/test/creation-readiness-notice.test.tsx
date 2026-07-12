import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { CreationReadinessNotice } from "../src/ui/creation/CreationReadinessNotice";
import { setupJsdom } from "./jsdomHarness";

describe("CreationReadinessNotice", () => {
  let harness: ReturnType<typeof setupJsdom>;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    harness = setupJsdom();
    container = harness.dom.window.document.getElementById("root") as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    harness.restore();
  });

  test("announces readiness validation to screen readers", () => {
    act(() => {
      root.render(
        createElement(CreationReadinessNotice, {
          checking: true,
          error: null,
          result: null,
          repairing: false,
          onRepair: () => {},
          onRetry: () => {},
        }),
      );
    });

    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toContain("Validating readiness");
  });

  test("renders an actionable assertive setup failure", () => {
    const onRepair = mock(() => {});
    act(() => {
      root.render(
        createElement(CreationReadinessNotice, {
          checking: false,
          error: null,
          result: {
            ready: false,
            checks: [
              {
                id: "research_credentials",
                status: "blocked",
                message: "Connect Google with an API key to use Deep Research.",
                repairAction: { type: "connectProvider", provider: "google" },
              },
              {
                id: "runtime_ready",
                status: "blocked",
                message: "LM Studio is not running.",
                repairAction: {
                  type: "startLmStudio",
                  baseUrl: "http://localhost:1234",
                  canAutoStart: true,
                },
              },
            ],
          },
          repairing: false,
          onRepair,
          onRetry: () => {},
        }),
      );
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.getAttribute("aria-live")).toBe("assertive");
    expect(alert?.textContent).toContain("Connect Google with an API key");
    const connect = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Connect Google"),
    );
    expect(connect).not.toBeNull();
    expect(container.textContent).toContain("Start LM Studio");
    act(() => connect?.click());
    expect(onRepair).toHaveBeenCalledWith({ type: "connectProvider", provider: "google" });
  });
});
