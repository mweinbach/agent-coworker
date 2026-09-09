import * as XLSX from "xlsx";

import type { SpreadsheetCellEditFailureKind } from "../../shared/spreadsheetPreview";

export type CellAddress = { row: number; col: number };
export type CellRange = { start: CellAddress; end: CellAddress };

const MAX_SPREADSHEET_ROWS = 1_048_576;
export const MAX_SPREADSHEET_COLS = 16_384;

export function parseAddress(address: string): CellAddress | null {
  const trimmed = address.trim().toUpperCase();
  if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(trimmed)) return null;
  const decoded = XLSX.utils.decode_cell(trimmed);
  if (
    !Number.isSafeInteger(decoded.r) ||
    !Number.isSafeInteger(decoded.c) ||
    decoded.r < 0 ||
    decoded.r >= MAX_SPREADSHEET_ROWS ||
    decoded.c < 0 ||
    decoded.c >= MAX_SPREADSHEET_COLS
  ) {
    return null;
  }
  return { row: decoded.r, col: decoded.c };
}

export function parseRange(rangeRef: string): CellRange | null {
  const parts = rangeRef
    .trim()
    .toUpperCase()
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;
  const start = parseAddress(parts[0] ?? "");
  const end = parseAddress(parts[1] ?? parts[0] ?? "");
  if (!start || !end) return null;
  return {
    start: {
      row: Math.min(start.row, end.row),
      col: Math.min(start.col, end.col),
    },
    end: {
      row: Math.max(start.row, end.row),
      col: Math.max(start.col, end.col),
    },
  };
}

/** Share delimiter selection between SheetJS previews and CSV write-back. */
export function readCsvDialect(text: string): {
  delimiter: string;
  preamble: string;
  content: string;
} {
  const content = text.replace(/^\uFEFF/, "");
  const preamble = /^sep=(.)(?:\r\n|\r|\n)/.exec(content);
  if (preamble) {
    return {
      delimiter: preamble[1] as string,
      preamble: preamble[0],
      content: content.slice(preamble[0].length),
    };
  }

  // Match SheetJS's supported delimiters and tie order, ignoring quoted text.
  const counts = new Map([
    [",", 0],
    ["\t", 0],
    [";", 0],
    ["|", 0],
  ]);
  let inQuotes = false;
  for (const character of content.slice(0, 1_024)) {
    if (character === '"') inQuotes = !inQuotes;
    else if (!inQuotes && counts.has(character)) {
      counts.set(character, (counts.get(character) ?? 0) + 1);
    }
  }
  let delimiter = ",";
  let largestCount = 0;
  for (const [candidate, count] of counts) {
    if (count > largestCount) {
      delimiter = candidate;
      largestCount = count;
    }
  }
  return { delimiter, preamble: "", content };
}

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

export type EditFailure = { kind: SpreadsheetCellEditFailureKind; message: string };

/**
 * Outcome of applying an ordered list of operations to one file. `index` marks
 * which operation failed so the batch entry point can attribute the error, or is
 * `null` when the failure isn't tied to a specific operation (file read/write,
 * post-batch validation, or an unsupported file type).
 */
export type OpsOutcome = { ok: true } | { ok: false; index: number | null; error: EditFailure };
