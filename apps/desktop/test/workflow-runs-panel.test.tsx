import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { ThreadWorkflowRun } from "../src/app/types";
import { WorkflowRunsPanel } from "../src/ui/WorkflowRunsPanel";
import { setupJsdom } from "./jsdomHarness";

function makeRun(overrides: Partial<ThreadWorkflowRun>): ThreadWorkflowRun {
  return {
    runId: "wf_default",
    name: "Workflow",
    phases: ["main"],
    currentPhase: "main",
    agents: [],
    logs: [],
    spentUsd: 0,
    ...overrides,
  };
}

describe("workflow runs panel", () => {
  test("renders newest-first status semantics and exposes agent states accessibly", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      const completedWithFailure = makeRun({
        runId: "wf_completed",
        name: "Completed review",
        outcome: "completed",
        spentUsd: 0.05,
        agents: [
          {
            index: 0,
            label: "failed worker",
            phase: "main",
            state: "errored",
            agentId: "child-failed",
            usdCost: 0.05,
            error: "reviewer returned malformed JSON",
          },
        ],
      });
      const cancelled = makeRun({
        runId: "wf_cancelled",
        name: "Cancelled review",
        outcome: "cancelled",
        agents: [
          {
            index: 0,
            label: "queued worker",
            phase: "main",
            state: "queued",
            agentId: null,
            usdCost: null,
          },
        ],
      });
      const failed = makeRun({
        runId: "wf_failed",
        name: "Failed synthesis",
        phases: ["research", "synthesis"],
        currentPhase: "synthesis",
        outcome: "errored",
        error: "invalid agent() call: prompt exceeds 20000 characters",
        logs: [`.ModelScratchpad/workflows/inputs/${"a".repeat(180)}.md`],
        agents: [
          {
            index: 0,
            label: "synthesis",
            phase: "synthesis",
            state: "errored",
            agentId: null,
            usdCost: null,
            error: "prompt exceeds 20000 characters",
          },
        ],
      });
      const legacyDryRun = makeRun({
        runId: "wf_dry",
        name: "Dry-run preview",
        outcome: "completed",
        agents: [
          {
            index: 0,
            label: "stub agent",
            phase: "main",
            state: "completed",
            agentId: null,
            usdCost: 0,
          },
        ],
      });

      await act(async () => {
        root.render(
          createElement(WorkflowRunsPanel, {
            runs: [legacyDryRun, completedWithFailure, cancelled, failed],
            sectionClassName: "section",
            scrollerClassName: "scroller",
          }),
        );
      });

      const buttons = [...container.querySelectorAll("button")];
      expect(buttons).toHaveLength(3);
      expect(buttons[0]?.getAttribute("aria-label")).toContain("Failed synthesis");
      expect(buttons[1]?.getAttribute("aria-label")).toContain("Cancelled review");
      expect(buttons[2]?.getAttribute("aria-label")).toContain("completed with 1 failed");
      expect(container.textContent).not.toContain("Dry-run preview");
      expect(container.textContent).toContain("invalid agent() call");
      expect(container.textContent).toContain("queued worker: cancelled");
      expect(container.textContent).toContain("failed worker: errored");
      expect(container.textContent).toContain("reviewer returned malformed JSON");

      await act(async () => {
        buttons[0]?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(harness.dom.window.document.body.textContent).toContain("wf_failed");
      expect(harness.dom.window.document.body.textContent).toContain("Failure reason");
      expect(harness.dom.window.document.body.textContent).toContain(
        "invalid agent() call: prompt exceeds 20000 characters",
      );
      expect(harness.dom.window.document.body.textContent).toContain(
        "prompt exceeds 20000 characters",
      );
      const dialog = harness.dom.window.document.body.querySelector('[data-slot="dialog-content"]');
      const stats = harness.dom.window.document.body.querySelector(
        '[data-slot="workflow-run-stats"]',
      );
      const logLine = harness.dom.window.document.body.querySelector(
        '[data-slot="workflow-run-log-line"]',
      );
      expect(dialog?.className).toContain("overflow-hidden");
      expect(stats?.className).toContain("grid-cols-2");
      expect(logLine?.className).toContain("break-all");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
