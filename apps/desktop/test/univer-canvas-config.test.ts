import { describe, expect, test } from "bun:test";

import { buildUniverSheetsFooterConfig } from "../src/lib/univerCanvasConfig";

describe("Univer canvas config", () => {
  test("keeps sheet switching visible without exposing unsupported sheet creation", () => {
    const footer = buildUniverSheetsFooterConfig();

    expect(footer.sheetBar).toBe(true);
    expect(footer.addSheetButtonConfig?.show).toBe(false);
  });
});
