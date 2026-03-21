import { describe, expect, test } from "bun:test";

import { renderHarnessContextSection } from "../src/harness/renderHarnessContextSection";

describe("renderHarnessContextSection", () => {
  test("returns empty string when context is absent", () => {
    expect(renderHarnessContextSection(null)).toBe("");
    expect(renderHarnessContextSection(undefined)).toBe("");
  });

  test("renders a stable structured section", () => {
    const rendered = renderHarnessContextSection({
      runId: "run-01",
      taskId: "task-01",
      objective: "Improve startup reliability.",
      acceptanceCriteria: ["Startup completes in under 800ms.", "No API contract changes."],
      constraints: ["Keep child-agent behavior backward-compatible."],
      metadata: {
        milestone: "phase-a",
        initiative: "harness-upgrade",
      },
      updatedAt: "2026-03-20T12:00:00.000Z",
    });

    expect(rendered).toContain("## Active Harness Context");
    expect(rendered).toContain("- Run ID: run-01");
    expect(rendered).toContain("- Task ID: task-01");
    expect(rendered).toContain("- Objective: Improve startup reliability.");
    expect(rendered).toContain("### Acceptance Criteria");
    expect(rendered).toContain("1. Startup completes in under 800ms.");
    expect(rendered).toContain("2. No API contract changes.");
    expect(rendered).toContain("### Constraints");
    expect(rendered).toContain("1. Keep child-agent behavior backward-compatible.");

    const initiativeIndex = rendered.indexOf("- initiative: harness-upgrade");
    const milestoneIndex = rendered.indexOf("- milestone: phase-a");
    expect(initiativeIndex).toBeGreaterThan(-1);
    expect(milestoneIndex).toBeGreaterThan(initiativeIndex);
  });

  test("removes blank list items and metadata entries", () => {
    const rendered = renderHarnessContextSection({
      runId: " run-02 ",
      objective: " Tighten validation. ",
      acceptanceCriteria: [" keep this ", " ", ""],
      constraints: ["", "  ", "preserve compatibility"],
      metadata: {
        "": "ignored",
        owner: " agent ",
        blank: "   ",
      },
      updatedAt: "2026-03-20T12:00:00.000Z",
    });

    expect(rendered).toContain("- Run ID: run-02");
    expect(rendered).toContain("- Objective: Tighten validation.");
    expect(rendered).toContain("1. keep this");
    expect(rendered).toContain("1. preserve compatibility");
    expect(rendered).toContain("- owner: agent");
    expect(rendered).not.toContain("ignored");
    expect(rendered).not.toContain("- blank:");
  });
});
