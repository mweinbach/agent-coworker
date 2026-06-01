import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { CrashReportingErrorBoundary } from "../src/ui/CrashReportingErrorBoundary";
import { setupJsdom } from "./jsdomHarness";

function ThrowingChild() {
  throw new Error("render blew up");
}

describe("crash reporting error boundary", () => {
  test("captures React render errors without requiring a Sentry SDK", async () => {
    const harness = setupJsdom();
    const originalConsoleError = console.error;
    const captureError = mock(() => {});
    console.error = mock(() => {}) as typeof console.error;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(
            CrashReportingErrorBoundary,
            { captureError },
            createElement(ThrowingChild),
          ),
        );
      });

      expect(container.textContent).toContain("Something went wrong.");
      expect(captureError).toHaveBeenCalledTimes(1);
      expect(captureError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect(captureError.mock.calls[0]?.[1]).toMatchObject({
        tags: { operation: "react_error_boundary" },
      });

      await act(async () => {
        root.unmount();
      });
    } finally {
      console.error = originalConsoleError;
      harness.restore();
    }
  });
});
