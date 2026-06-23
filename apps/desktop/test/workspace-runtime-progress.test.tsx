import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { WorkspaceRuntimeProgress } from "../src/ui/WorkspaceRuntimeProgress";
import { setupJsdom } from "./jsdomHarness";

describe("WorkspaceRuntimeProgress", () => {
  test("renders a determinate download bar and loading symbol", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(WorkspaceRuntimeProgress, {
            progress: {
              phase: "downloading",
              version: "2026-06-22",
              transferredBytes: 50 * 1024 * 1024,
              totalBytes: 100 * 1024 * 1024,
              percent: 50,
            },
          }),
        );
      });

      expect(container.textContent).toContain("Getting Cowork ready");
      expect(container.textContent).toContain("Downloading runtime");
      expect(container.textContent).toContain("50%");
      expect(container.textContent).toContain("50.0 MB of 100 MB");
      expect(container.textContent).toContain("Download");
      expect(container.textContent).toContain("Verify");
      expect(container.textContent).toContain("Start workspace");
      expect(container.querySelector('svg[role="status"]')).not.toBeNull();
      const progressbar = container.querySelector('[role="progressbar"]');
      expect(progressbar?.getAttribute("aria-valuenow")).toBe("50");
      expect(progressbar?.hasAttribute("aria-busy")).toBe(false);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test("uses an indeterminate bar when the server cannot determine total bytes", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(WorkspaceRuntimeProgress, {
            progress: {
              phase: "downloading",
              version: "2026-06-22",
              transferredBytes: 2 * 1024 * 1024,
              totalBytes: null,
              percent: null,
            },
          }),
        );
      });

      expect(container.textContent).toContain("2.0 MB downloaded");
      const progressbar = container.querySelector('[role="progressbar"]');
      expect(progressbar?.getAttribute("aria-busy")).toBe("true");
      expect(progressbar?.hasAttribute("aria-valuenow")).toBe(false);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });
});
