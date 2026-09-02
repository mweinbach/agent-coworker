import * as XLSX from "xlsx";

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
