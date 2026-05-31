import { describe, expect, test } from "bun:test";

import { buildUniverSheetsFooterConfig } from "../src/lib/univerCanvasConfig";

describe("Univer canvas config", () => {
  test("hides unsupported sheet tab mutations until sheet operations can persist", () => {
    const footer = buildUniverSheetsFooterConfig();

    expect(footer.sheetBar).toBe(false);
    expect(footer.statisticBar).toBe(true);
    expect(footer.zoomSlider).toBe(true);
  });
});
