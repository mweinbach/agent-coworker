import { describe, expect, test } from "bun:test";

import { shouldDeferExternalWorkbookReload } from "../src/lib/univerSaveState";

describe("Univer save state helpers", () => {
  test("defers external reload while local edits may be unsaved", () => {
    expect(shouldDeferExternalWorkbookReload("dirty")).toBe(true);
    expect(shouldDeferExternalWorkbookReload("saving")).toBe(true);
    expect(shouldDeferExternalWorkbookReload("error")).toBe(true);
  });

  test("allows external reload when there are no pending local edits", () => {
    expect(shouldDeferExternalWorkbookReload("idle")).toBe(false);
    expect(shouldDeferExternalWorkbookReload("saved")).toBe(false);
  });
});
