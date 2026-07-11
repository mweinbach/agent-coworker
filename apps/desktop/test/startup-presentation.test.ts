import { describe, expect, test } from "bun:test";

import { startupStagePresentation } from "../src/ui/recovery/startupPresentation";

describe("startup phase presentation", () => {
  test("describes each bootstrap stage with truthful user-facing work", () => {
    expect(startupStagePresentation("restoring-workspace")).toEqual({
      title: "Restoring your workspace",
      detail: "Loading saved chats, drafts, and workspace settings.",
    });
    expect(startupStagePresentation("checking-services")).toEqual({
      title: "Checking desktop services",
      detail: "Confirming local services and update state.",
    });
    expect(startupStagePresentation("reconnecting-sessions")).toEqual({
      title: "Reconnecting recent sessions",
      detail: "Bringing your latest conversation back online.",
    });
  });

  test("never labels an unknown or failed startup as recovered", () => {
    const presentation = startupStagePresentation(null);
    expect(presentation.title).toBe("Starting Cowork");
    expect(`${presentation.title} ${presentation.detail}`).not.toContain("Recovered");
  });
});
