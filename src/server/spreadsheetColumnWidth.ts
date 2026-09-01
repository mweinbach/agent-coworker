// OOXML stores outer column widths in units of the Normal font's maximum digit
// width. Use a stable 7px (Calibri 11 at 96 DPI) baseline for our CSS-pixel
// renderer, not SheetJS's process-global font-width guess. Native spreadsheet
// apps can scale these widths differently with other fonts or display settings.
const MAX_DIGIT_WIDTH_PX = 7;
const COLUMN_PADDING_PX = 5;
const WIDTH_UNITS = 256;
export const MAX_OOXML_COLUMN_WIDTH = 255;
export const MAX_COLUMN_WIDTH_PX = MAX_OOXML_COLUMN_WIDTH * MAX_DIGIT_WIDTH_PX;

export function encodeColumnWidth(widthPx: number): number {
  return Math.trunc((Math.round(widthPx) / MAX_DIGIT_WIDTH_PX) * WIDTH_UNITS) / WIDTH_UNITS;
}

export function decodeColumnWidth(width: number): { widthPx: number; widthChars: number } {
  const widthPx = Math.trunc(
    ((WIDTH_UNITS * width + Math.trunc(128 / MAX_DIGIT_WIDTH_PX)) / WIDTH_UNITS) *
      MAX_DIGIT_WIDTH_PX,
  );
  return {
    widthPx,
    widthChars: Math.max(
      0,
      Math.round(((widthPx - COLUMN_PADDING_PX) / MAX_DIGIT_WIDTH_PX) * 100) / 100,
    ),
  };
}
