import { describe, expect, test } from "bun:test";

import { formatTaskStatus, taskStatusBadgeClassName } from "../src/ui/tasks/taskPresentation";

describe("task presentation", () => {
  test("keeps task status labels human readable", () => {
    expect(formatTaskStatus("awaiting_review")).toBe("Awaiting review");
  });

  test("uses the accessible low-emphasis surface for blocked task badges", () => {
    const className = taskStatusBadgeClassName("blocked");

    expect(className).toContain("bg-destructive/5");
    expect(className).toContain("text-foreground");
    expect(className).not.toContain("bg-destructive/10");
    expect(className).not.toContain("text-destructive");
  });

  test("uses readable foreground text for completed task badges", () => {
    const className = taskStatusBadgeClassName("completed");

    expect(className).toContain("text-foreground");
    expect(className).not.toContain("text-success");
  });
});
