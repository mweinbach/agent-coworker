import fs from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";

import {
  SPREADSHEET_PREVIEW_DEFAULT_COL_COUNT,
  SPREADSHEET_PREVIEW_DEFAULT_ROW_COUNT,
  SPREADSHEET_PREVIEW_MAX_COL_COUNT,
  SPREADSHEET_PREVIEW_MAX_ROW_COUNT,
  type SpreadsheetCellStyle,
  type SpreadsheetColumnWidth,
  type SpreadsheetFileKind,
  type SpreadsheetMergedRange,
  type SpreadsheetPreview,
  type SpreadsheetPreviewCell,
  type SpreadsheetPreviewResult,
  type SpreadsheetPreviewViewport,
  type SpreadsheetPreviewViewportRequest,
  type SpreadsheetSheetSummary,
} from "../shared/spreadsheetPreview";

type Worksheet = XLSX.WorkSheet;
type Workbook = XLSX.WorkBook;

export type SpreadsheetPreviewRequest = {
  cwd: string;
  filePath: string;
  sheetName?: string;
  viewport?: SpreadsheetPreviewViewportRequest;
};

export async function previewSpreadsheetFile(
  request: SpreadsheetPreviewRequest,
): Promise<SpreadsheetPreviewResult> {
  const resolvedPath = await resolveWorkspaceFilePath(request.cwd, request.filePath);
  const kind = spreadsheetKindForPath(resolvedPath);
  if (!kind) {
    return {
      ok: false,
      error: {
        kind: "unsupported_format",
        message: "Spreadsheet preview supports CSV and XLSX files.",
      },
      warnings: [],
    };
  }

  try {
    const bytes = await fs.readFile(resolvedPath);
    if (kind === "csv") {
      validateCsvQuoteBalance(bytes.toString("utf8"));
    } else {
      validateXlsxZipSignature(bytes);
    }
    const workbook = readWorkbook(bytes, kind);
    const preview = buildSpreadsheetPreview({
      workbook,
      kind,
      filePath: resolvedPath,
      requestedSheetName: request.sheetName,
      requestedViewport: request.viewport,
    });
    return { ok: true, preview };
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "parse_error",
        message: error instanceof Error ? error.message : String(error),
      },
      warnings: [],
    };
  }
}

export async function resolveWorkspaceFilePath(cwd: string, filePath: string): Promise<string> {
  const workspaceRoot = await fs.realpath(cwd);
  const candidate = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspaceRoot, filePath);
  const resolvedCandidate = await fs.realpath(candidate);
  const relative = path.relative(workspaceRoot, resolvedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside the workspace root.");
  }
  return resolvedCandidate;
}

function spreadsheetKindForPath(filePath: string): SpreadsheetFileKind | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") return "csv";
  if (ext === ".xlsx") return "xlsx";
  return null;
}

function readWorkbook(bytes: Buffer, kind: SpreadsheetFileKind): Workbook {
  return XLSX.read(bytes, {
    type: "buffer",
    cellDates: true,
    cellFormula: true,
    cellNF: true,
    cellStyles: true,
    raw: kind === "csv" ? false : undefined,
  });
}

function buildSpreadsheetPreview(opts: {
  workbook: Workbook;
  kind: SpreadsheetFileKind;
  filePath: string;
  requestedSheetName?: string;
  requestedViewport?: SpreadsheetPreviewViewportRequest;
}): SpreadsheetPreview {
  const sheetNames = opts.kind === "csv" ? ["CSV"] : opts.workbook.SheetNames;
  const sheets = sheetNames.map((name, index) =>
    summarizeSheet(
      name,
      readWorksheet(opts.workbook, opts.kind, name, index),
      opts.workbook,
      index,
    ),
  );
  if (sheets.length === 0) {
    throw new Error("Workbook does not contain any sheets.");
  }

  const selectedSheetName =
    opts.requestedSheetName && sheetNames.includes(opts.requestedSheetName)
      ? opts.requestedSheetName
      : (sheetNames[0] ?? "Sheet1");
  const selectedIndex = Math.max(0, sheetNames.indexOf(selectedSheetName));
  const worksheet = readWorksheet(opts.workbook, opts.kind, selectedSheetName, selectedIndex);
  if (!worksheet) {
    throw new Error(`Sheet not found: ${selectedSheetName}`);
  }
  const selectedSummary = sheets[selectedIndex] ?? sheets[0];
  if (!selectedSummary) {
    throw new Error("Workbook does not contain a readable sheet.");
  }
  const viewport = buildViewport(selectedSummary, opts.requestedViewport);

  return {
    kind: opts.kind,
    path: opts.filePath,
    filename: path.basename(opts.filePath),
    sheets,
    selectedSheetName: selectedSummary.name,
    viewport,
    cells: buildVisibleCells(worksheet, viewport),
    mergedCells: readMergedCells(worksheet, viewport),
    columnWidths: readColumnWidths(worksheet, viewport),
    warnings: buildWarnings(selectedSummary, viewport),
  };
}

function readWorksheet(
  workbook: Workbook,
  kind: SpreadsheetFileKind,
  sheetName: string,
  index: number,
): Worksheet | undefined {
  if (kind === "csv") {
    return workbook.Sheets[workbook.SheetNames[0] ?? sheetName];
  }
  return workbook.Sheets[sheetName] ?? workbook.Sheets[workbook.SheetNames[index] ?? ""];
}

function summarizeSheet(
  name: string,
  worksheet: Worksheet | undefined,
  workbook: Workbook,
  index: number,
): SpreadsheetSheetSummary {
  const range = worksheet ? readSheetRange(worksheet) : null;
  const hiddenValue = workbook.Workbook?.Sheets?.[index]?.Hidden;
  return {
    name,
    rowCount: range ? range.e.r + 1 : 0,
    colCount: range ? range.e.c + 1 : 0,
    ...(hiddenValue ? { hidden: true } : {}),
  };
}

function readSheetRange(worksheet: Worksheet): XLSX.Range | null {
  const ref = worksheet["!ref"];
  if (!ref) return null;
  try {
    return XLSX.utils.decode_range(ref);
  } catch {
    return null;
  }
}

function buildViewport(
  sheet: SpreadsheetSheetSummary,
  requested?: SpreadsheetPreviewViewportRequest,
): SpreadsheetPreviewViewport {
  const startRow = clampInteger(requested?.startRow, 0, Math.max(sheet.rowCount - 1, 0), 0);
  const startCol = clampInteger(requested?.startCol, 0, Math.max(sheet.colCount - 1, 0), 0);
  const requestedRows = requested?.rowCount ?? SPREADSHEET_PREVIEW_DEFAULT_ROW_COUNT;
  const requestedCols = requested?.colCount ?? SPREADSHEET_PREVIEW_DEFAULT_COL_COUNT;
  const rowCount = Math.min(
    clampInteger(
      requestedRows,
      1,
      SPREADSHEET_PREVIEW_MAX_ROW_COUNT,
      SPREADSHEET_PREVIEW_DEFAULT_ROW_COUNT,
    ),
    Math.max(sheet.rowCount - startRow, 0),
  );
  const colCount = Math.min(
    clampInteger(
      requestedCols,
      1,
      SPREADSHEET_PREVIEW_MAX_COL_COUNT,
      SPREADSHEET_PREVIEW_DEFAULT_COL_COUNT,
    ),
    Math.max(sheet.colCount - startCol, 0),
  );
  const endRow = rowCount > 0 ? startRow + rowCount - 1 : startRow;
  const endCol = colCount > 0 ? startCol + colCount - 1 : startCol;
  return {
    startRow,
    startCol,
    rowCount,
    colCount,
    endRow,
    endCol,
    totalRows: sheet.rowCount,
    totalCols: sheet.colCount,
    truncatedRows: startRow + rowCount < sheet.rowCount,
    truncatedCols: startCol + colCount < sheet.colCount,
  };
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function buildVisibleCells(
  worksheet: Worksheet,
  viewport: SpreadsheetPreviewViewport,
): SpreadsheetPreviewCell[][] {
  const rows: SpreadsheetPreviewCell[][] = [];
  for (let row = viewport.startRow; row <= viewport.endRow && viewport.rowCount > 0; row++) {
    const cells: SpreadsheetPreviewCell[] = [];
    for (let col = viewport.startCol; col <= viewport.endCol && viewport.colCount > 0; col++) {
      const address = XLSX.utils.encode_cell({ r: row, c: col });
      cells.push(buildCell(row, col, address, worksheet[address] as XLSX.CellObject | undefined));
    }
    rows.push(cells);
  }
  return rows;
}

function buildCell(
  row: number,
  col: number,
  address: string,
  cell: XLSX.CellObject | undefined,
): SpreadsheetPreviewCell {
  const value = cell ? stringifyCellValue(cell) : "";
  const style = cell ? readCellStyle(cell) : undefined;
  return {
    row,
    col,
    address,
    value,
    ...(cell?.w && cell.w !== value ? { formattedValue: cell.w } : {}),
    ...(cell && "v" in cell ? { rawValue: normalizeRawValue(cell.v) } : {}),
    ...(cell?.f ? { formula: cell.f } : {}),
    ...(cell?.t ? { type: cell.t } : {}),
    ...(style ? { style } : {}),
  };
}

function stringifyCellValue(cell: XLSX.CellObject): string {
  if (cell.w !== undefined) return String(cell.w);
  if (cell.v === undefined || cell.v === null) return "";
  if (cell.v instanceof Date) return cell.v.toISOString();
  return String(cell.v);
}

function normalizeRawValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function readCellStyle(cell: XLSX.CellObject): SpreadsheetCellStyle | undefined {
  const record = cell as XLSX.CellObject & { s?: Record<string, unknown>; z?: string };
  const style = record.s;
  const font = readRecord(style?.font);
  const fill = readRecord(style?.fill);
  const alignment = readRecord(style?.alignment);
  const result: SpreadsheetCellStyle = {
    ...(font?.bold === true ? { bold: true } : {}),
    ...(font?.italic === true ? { italic: true } : {}),
    ...(typeof alignment?.horizontal === "string" ? { horizontalAlign: alignment.horizontal } : {}),
    ...(typeof record.z === "string" ? { numberFormat: record.z } : {}),
  };
  const fillColor = readColor(fill?.fgColor) ?? readColor(fill?.bgColor);
  if (fillColor) result.fillColor = fillColor;
  const textColor = readColor(font?.color);
  if (textColor) result.textColor = textColor;
  return Object.keys(result).length > 0 ? result : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readColor(value: unknown): string | null {
  const record = readRecord(value);
  const rgb = typeof record?.rgb === "string" ? record.rgb : null;
  if (!rgb) return null;
  const normalized = rgb.length === 8 ? rgb.slice(2) : rgb;
  return /^[0-9a-fA-F]{6}$/.test(normalized) ? `#${normalized.toUpperCase()}` : null;
}

function readMergedCells(
  worksheet: Worksheet,
  viewport: SpreadsheetPreviewViewport,
): SpreadsheetMergedRange[] {
  const merges = worksheet["!merges"] ?? [];
  return merges
    .filter((merge) => rangesIntersect(merge, viewport))
    .map((merge) => ({
      ref: XLSX.utils.encode_range(merge),
      startRow: merge.s.r,
      startCol: merge.s.c,
      endRow: merge.e.r,
      endCol: merge.e.c,
    }));
}

function rangesIntersect(range: XLSX.Range, viewport: SpreadsheetPreviewViewport): boolean {
  return !(
    range.e.r < viewport.startRow ||
    range.s.r > viewport.endRow ||
    range.e.c < viewport.startCol ||
    range.s.c > viewport.endCol
  );
}

function readColumnWidths(
  worksheet: Worksheet,
  viewport: SpreadsheetPreviewViewport,
): SpreadsheetColumnWidth[] {
  const cols = worksheet["!cols"] ?? [];
  const widths: SpreadsheetColumnWidth[] = [];
  for (let col = viewport.startCol; col <= viewport.endCol && viewport.colCount > 0; col++) {
    const colInfo = cols[col] as { wch?: number; wpx?: number } | undefined;
    if (!colInfo) continue;
    widths.push({
      col,
      ...(typeof colInfo.wch === "number" ? { widthChars: colInfo.wch } : {}),
      ...(typeof colInfo.wpx === "number" ? { widthPx: colInfo.wpx } : {}),
    });
  }
  return widths;
}

function buildWarnings(
  sheet: SpreadsheetSheetSummary,
  viewport: SpreadsheetPreviewViewport,
): string[] {
  const warnings: string[] = [];
  if (viewport.truncatedRows || viewport.truncatedCols) {
    warnings.push(
      `Showing rows ${viewport.startRow + 1}-${viewport.endRow + 1} and columns ${viewport.startCol + 1}-${viewport.endCol + 1} of ${sheet.rowCount} rows and ${sheet.colCount} columns.`,
    );
  }
  return warnings;
}

function validateCsvQuoteBalance(input: string): void {
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== '"') continue;
    if (inQuotes && input[i + 1] === '"') {
      i += 1;
      continue;
    }
    inQuotes = !inQuotes;
  }
  if (inQuotes) {
    throw new Error("CSV has an unterminated quoted field.");
  }
}

export function validateXlsxZipSignature(bytes: Buffer): void {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return;
  }
  throw new Error("XLSX file is not a valid Office Open XML zip package.");
}
