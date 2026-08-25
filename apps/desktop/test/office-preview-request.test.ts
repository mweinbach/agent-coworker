import { describe, expect, test } from "bun:test";

import { runOfficePreviewRequest } from "../src/lib/officePreviewRequest";

describe("Office preview requests", () => {
  test("returns a completed workspace response", async () => {
    await expect(runOfficePreviewRequest(async () => "ready", "Workbook", 100)).resolves.toBe(
      "ready",
    );
  });

  test("turns a stalled workspace request into an actionable error", async () => {
    await expect(
      runOfficePreviewRequest(() => new Promise<string>(() => {}), "Workbook", 5),
    ).rejects.toThrow(
      "Workbook preview timed out while contacting the workspace. Please try again.",
    );
  });
});
