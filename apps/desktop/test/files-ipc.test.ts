import { describe, expect, test } from "bun:test";

import { isExplorerEntryHidden } from "../electron/services/explorerVisibility";

describe("files IPC hidden entry detection", () => {
  test("treats Office lockfiles as hidden", () => {
    expect(isExplorerEntryHidden("~$preview_latency_review.docx")).toBe(true);
    expect(isExplorerEntryHidden("~$budget.xlsx")).toBe(true);
  });

  test("keeps normal workspace files visible", () => {
    expect(isExplorerEntryHidden("preview_latency_review.docx")).toBe(false);
    expect(isExplorerEntryHidden("notes.md")).toBe(false);
  });
});
