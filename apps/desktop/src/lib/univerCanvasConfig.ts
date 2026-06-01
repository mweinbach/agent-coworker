import type { IUniverSheetsCorePresetConfig } from "@univerjs/preset-sheets-core";

export type UniverSheetsFooterConfig = Exclude<
  IUniverSheetsCorePresetConfig["footer"],
  false | undefined
>;

export function buildUniverSheetsFooterConfig(): UniverSheetsFooterConfig {
  return {
    sheetBar: false,
    statisticBar: true,
    menus: true,
    zoomSlider: true,
  };
}
