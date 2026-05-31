import type { IUniverSheetsCorePresetConfig } from "@univerjs/preset-sheets-core";

export type UniverSheetsFooterConfig = Exclude<
  IUniverSheetsCorePresetConfig["footer"],
  false | undefined
>;

export function buildUniverSheetsFooterConfig(): UniverSheetsFooterConfig {
  return {
    sheetBar: true,
    statisticBar: true,
    menus: true,
    zoomSlider: true,
    addSheetButtonConfig: {
      show: false,
    },
  };
}
