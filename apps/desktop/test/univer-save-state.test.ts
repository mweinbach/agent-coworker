import { describe, expect, test } from "bun:test";

import {
  isWorkbookSnapshotForPath,
  shouldBlockSpreadsheetUnload,
  shouldDeferExternalWorkbookReload,
} from "../src/lib/univerSaveState";

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

  test("blocks window unload while failed saves may still hold local edits", () => {
    expect(shouldBlockSpreadsheetUnload("dirty", null)).toBe(true);
    expect(shouldBlockSpreadsheetUnload("saving", null)).toBe(true);
    expect(shouldBlockSpreadsheetUnload("error", null)).toBe(true);
    expect(shouldBlockSpreadsheetUnload("idle", Promise.resolve(true))).toBe(true);
    expect(shouldBlockSpreadsheetUnload("idle", null)).toBe(false);
    expect(shouldBlockSpreadsheetUnload("saved", null)).toBe(false);
  });

  test("identifies workbook snapshots that belong to the current canvas path", () => {
    expect(isWorkbookSnapshotForPath({ path: "/tmp/model.xlsx" }, "/tmp/model.xlsx")).toBe(true);
    expect(isWorkbookSnapshotForPath({ path: "/tmp/old.xlsx" }, "/tmp/model.xlsx")).toBe(false);
    expect(isWorkbookSnapshotForPath(null, "/tmp/model.xlsx")).toBe(false);
  });
});
