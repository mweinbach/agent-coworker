import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { CoworkRuntimeBootstrapProgress } from "../../../src/coworkRuntime/types";
import { WorkspaceRuntimeProgress } from "../src/ui/WorkspaceRuntimeProgress";
import { setupJsdom } from "./jsdomHarness";

const downloadProgress: CoworkRuntimeBootstrapProgress = {
  phase: "downloading",
  version: "2026-06-22",
  transferredBytes: 50 * 1024 * 1024,
  totalBytes: 100 * 1024 * 1024,
  percent: 50,
};

async function withProgress(
  progress: CoworkRuntimeBootstrapProgress,
  assert: (container: HTMLElement) => void,
  compact = false,
) {
  const harness = setupJsdom();
  const container = harness.dom.window.document.getElementById("root");
  if (!container) throw new Error("missing root");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(WorkspaceRuntimeProgress, { progress, compact }));
    });
    assert(container);
  } finally {
    await act(async () => root.unmount());
    harness.restore();
  }
}

describe("WorkspaceRuntimeProgress", () => {
  test.each([false, true])(
    "shows actual download numbers without a loading bar (compact: %s)",
    async (compact) => {
      await withProgress(
        downloadProgress,
        (container) => {
          expect(container.textContent).toContain("Getting Cowork ready");
          expect(container.textContent).toContain("50%");
          expect(container.textContent).toContain("50.0 MB of 100 MB");
          expect(container.querySelector('[role="status"]')?.textContent).toBe(
            "Downloading local tools",
          );
          expect(container.querySelector('[aria-current="step"]')?.textContent).toBe("Download");
          expect(container.querySelector('[role="progressbar"]')).toBeNull();
          expect(container.querySelector('[class*="animate-"]')).toBeNull();
          expect(container.querySelector('[role="status"]')?.textContent).not.toContain("50%");
        },
        compact,
      );
    },
  );

  test("shows bytes without inventing a percent when the total is unknown", async () => {
    await withProgress(
      { ...downloadProgress, transferredBytes: 2 * 1024 * 1024, totalBytes: null, percent: null },
      (container) => {
        expect(container.textContent).toContain("2.0 MB downloaded");
        expect(container.textContent).not.toContain("%");
        expect(container.querySelector('[role="progressbar"]')).toBeNull();
      },
    );
  });

  test("does not fabricate transferred bytes before download telemetry arrives", async () => {
    await withProgress(
      { ...downloadProgress, transferredBytes: null, percent: null },
      (container) => {
        expect(container.textContent).toContain("Downloading local tools");
        expect(container.textContent).not.toContain("0 B");
        expect(container.textContent).not.toContain("%");
      },
    );
  });

  test.each([
    { phase: "waiting", label: "Waiting for setup", currentStep: null },
    { phase: "installing", label: "Verifying and installing", currentStep: "Verify" },
    { phase: "ready", label: "Starting workspace", currentStep: "Start workspace" },
  ] as const)(
    "keeps the $phase phase honest without simulated progress",
    async ({ phase, label, currentStep }) => {
      await withProgress(
        { ...downloadProgress, phase, transferredBytes: null, totalBytes: null, percent: null },
        (container) => {
          expect(container.querySelector('[role="status"]')?.textContent).toBe(label);
          expect(container.querySelector('[aria-current="step"]')?.textContent ?? null).toBe(
            currentStep,
          );
          expect(container.querySelector('[role="progressbar"]')).toBeNull();
          expect(container.querySelector('[class*="animate-"]')).toBeNull();
          expect(container.textContent).not.toContain("%");
          expect(container.textContent).not.toContain("Almost ready");
          expect(container.textContent).toContain("Your workspace will open automatically");
        },
      );
    },
  );
});
