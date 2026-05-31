import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";

import type {
  SpreadsheetCellStyle,
  SpreadsheetColumnWidth,
  SpreadsheetFileKind,
  SpreadsheetFileVersion,
  SpreadsheetFileVersionResult,
  SpreadsheetMergedRange,
  SpreadsheetPreviewCell,
  SpreadsheetPreviewViewport,
  SpreadsheetSheetSummary,
  SpreadsheetWorkbookSnapshot,
  SpreadsheetWorkbookSnapshotResult,
  SpreadsheetWorkbookSnapshotSheet,
} from "../shared/spreadsheetPreview";
import { readOoxmlColor, readXlsxSheetObjects, type XlsxSheetObjects } from "./spreadsheetOoxml";

type Worksheet = XLSX.WorkSheet;
type Workbook = XLSX.WorkBook;
const OUTSIDE_WORKSPACE_MESSAGE = "Path is outside the workspace root.";

export type SpreadsheetWorkbookRequest = {
  cwd: string;
  filePath: string;
  sheetName?: string;
};

export async function readSpreadsheetWorkbookSnapshot(
  request: SpreadsheetWorkbookRequest,
): Promise<SpreadsheetWorkbookSnapshotResult> {
  try {
    const resolvedPath = await resolveWorkspaceFilePath(request.cwd, request.filePath);
    const kind = spreadsheetKindForPath(resolvedPath);
    if (!kind) {
      return {
        ok: false,
        error: {
          kind: "unsupported_format",
          message: "Spreadsheet workbook snapshots support CSV and XLSX files.",
        },
        warnings: [],
      };
    }

    const stat = await fs.stat(resolvedPath);
    const bytes = await fs.readFile(resolvedPath);
    if (kind === "csv") {
      validateCsvQuoteBalance(bytes.toString("utf8"));
    } else {
      validateXlsxZipSignature(bytes);
    }
    const workbook = readWorkbook(bytes, kind);
    const snapshot = await buildSpreadsheetWorkbookSnapshot({
      workbook,
      kind,
      filePath: resolvedPath,
      bytes,
      fileVersion: spreadsheetFileVersionFromStat(stat),
      requestedSheetName: request.sheetName,
    });
    return { ok: true, workbook: snapshot };
  } catch (error) {
    if (isFileNotFoundError(error) || isOutsideWorkspaceError(error)) {
      return {
        ok: false,
        error: spreadsheetPathFailure(error),
        warnings: [],
      };
    }
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

export async function readSpreadsheetFileVersion(
  request: Pick<SpreadsheetWorkbookRequest, "cwd" | "filePath">,
): Promise<SpreadsheetFileVersionResult> {
  let resolvedPath: string;
  try {
    resolvedPath = await resolveWorkspaceFilePath(request.cwd, request.filePath);
  } catch (error) {
    const failure = spreadsheetPathFailure(error);
    return {
      ok: false,
      error: failure,
      warnings: [],
    };
  }

  const kind = spreadsheetKindForPath(resolvedPath);
  if (!kind) {
    return {
      ok: false,
      error: {
        kind: "unsupported_format",
        message: "Spreadsheet file versions support CSV and XLSX files.",
      },
      warnings: [],
    };
  }

  try {
    const stat = await fs.stat(resolvedPath);
    return {
      ok: true,
      version: spreadsheetFileVersionFromStat(stat),
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: isFileNotFoundError(error) ? "not_found" : "parse_error",
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
    throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
  }
  return resolvedCandidate;
}

export function spreadsheetPathFailure(error: unknown): {
  kind: "not_found" | "outside_workspace";
  message: string;
} {
  if (isFileNotFoundError(error)) {
    return { kind: "not_found", message: "Spreadsheet file was not found." };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: message === OUTSIDE_WORKSPACE_MESSAGE ? "outside_workspace" : "not_found",
    message,
  };
}

function isOutsideWorkspaceError(error: unknown): boolean {
  return error instanceof Error && error.message === OUTSIDE_WORKSPACE_MESSAGE;
}

function spreadsheetFileVersionFromStat(stat: Stats): SpreadsheetFileVersion {
  const modifiedAtMs = Math.round(stat.mtimeMs);
  const changeTimeMs = Math.round(stat.ctimeMs);
  return {
    modifiedAtMs,
    changeTimeMs,
    size: stat.size,
    fingerprint: `${modifiedAtMs}:${changeTimeMs}:${stat.size}`,
  };
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
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

async function buildSpreadsheetWorkbookSnapshot(opts: {
  workbook: Workbook;
  kind: SpreadsheetFileKind;
  filePath: string;
  bytes: Buffer;
  fileVersion: SpreadsheetFileVersion;
  requestedSheetName?: string;
}): Promise<SpreadsheetWorkbookSnapshot> {
  const sheetNames = opts.kind === "csv" ? ["CSV"] : opts.workbook.SheetNames;
  const sheetSummaries = sheetNames.map((name, index) =>
    summarizeSheet(
      name,
      readWorksheet(opts.workbook, opts.kind, name, index),
      opts.workbook,
      index,
    ),
  );
  if (sheetSummaries.length === 0) {
    throw new Error("Workbook does not contain any sheets.");
  }

  const warnings: string[] = [];
  const sheets: SpreadsheetWorkbookSnapshotSheet[] = [];
  for (const [index, sheet] of sheetSummaries.entries()) {
    const worksheet = readWorksheet(opts.workbook, opts.kind, sheet.name, index);
    const viewport = buildFullSheetViewport(sheet);
    let packageDetails: XlsxSheetObjects = { tables: [], charts: [], cellStyles: new Map() };
    if (opts.kind === "xlsx") {
      try {
        packageDetails = await readXlsxSheetObjects(opts.bytes, sheet.name);
      } catch (metadataError) {
        warnings.push(
          `${sheet.name}: workbook objects could not be read: ${
            metadataError instanceof Error ? metadataError.message : String(metadataError)
          }`,
        );
      }
    }

    sheets.push({
      ...sheet,
      id: `sheet-${index + 1}`,
      cells: worksheet
        ? buildSnapshotCells(worksheet, packageDetails.cellStyles, viewport)
        : buildStyledBlankCells(packageDetails.cellStyles, viewport),
      mergedCells: worksheet ? readMergedCells(worksheet, viewport) : [],
      columnWidths: worksheet ? readColumnWidths(worksheet, viewport) : [],
      tables: packageDetails.tables,
      charts: packageDetails.charts,
    });
  }

  const activeSheetName =
    opts.requestedSheetName && sheetNames.includes(opts.requestedSheetName)
      ? opts.requestedSheetName
      : (sheetNames[0] ?? "Sheet1");

  return {
    kind: opts.kind,
    path: opts.filePath,
    filename: path.basename(opts.filePath),
    fileVersion: opts.fileVersion,
    sheets,
    activeSheetName,
    warnings,
  };
}

function buildFullSheetViewport(sheet: SpreadsheetSheetSummary): SpreadsheetPreviewViewport {
  const rowCount = Math.max(sheet.rowCount, 0);
  const colCount = Math.max(sheet.colCount, 0);
  return {
    startRow: 0,
    startCol: 0,
    rowCount,
    colCount,
    endRow: rowCount > 0 ? rowCount - 1 : 0,
    endCol: colCount > 0 ? colCount - 1 : 0,
    totalRows: rowCount,
    totalCols: colCount,
    truncatedRows: false,
    truncatedCols: false,
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

function buildSnapshotCells(
  worksheet: Worksheet,
  packageStyles: Map<string, SpreadsheetCellStyle>,
  viewport: SpreadsheetPreviewViewport,
): SpreadsheetPreviewCell[] {
  const cells = new Map<string, SpreadsheetPreviewCell>();
  for (const key of Object.keys(worksheet)) {
    if (key.startsWith("!")) continue;
    const address = normalizeCellAddress(key);
    if (!address) continue;
    const decoded = XLSX.utils.decode_cell(address);
    if (!cellInsideViewport(decoded.r, decoded.c, viewport)) continue;
    cells.set(
      address,
      buildCell(decoded.r, decoded.c, address, worksheet[address] as XLSX.CellObject | undefined),
    );
  }

  for (const [address, style] of packageStyles.entries()) {
    const decoded = XLSX.utils.decode_cell(address);
    if (!cellInsideViewport(decoded.r, decoded.c, viewport)) continue;
    const existing = cells.get(address);
    cells.set(address, {
      ...(existing ?? buildCell(decoded.r, decoded.c, address, undefined)),
      style: {
        ...existing?.style,
        ...style,
      },
    });
  }

  return [...cells.values()].sort((left, right) => left.row - right.row || left.col - right.col);
}

function buildStyledBlankCells(
  packageStyles: Map<string, SpreadsheetCellStyle>,
  viewport: SpreadsheetPreviewViewport,
): SpreadsheetPreviewCell[] {
  const cells: SpreadsheetPreviewCell[] = [];
  for (const [address, style] of packageStyles.entries()) {
    const decoded = XLSX.utils.decode_cell(address);
    if (!cellInsideViewport(decoded.r, decoded.c, viewport)) continue;
    cells.push({
      ...buildCell(decoded.r, decoded.c, address, undefined),
      style,
    });
  }
  return cells.sort((left, right) => left.row - right.row || left.col - right.col);
}

function normalizeCellAddress(key: string): string | null {
  if (!/^[A-Z]+[1-9][0-9]*$/i.test(key)) return null;
  return key.toUpperCase();
}

function cellInsideViewport(
  row: number,
  col: number,
  viewport: SpreadsheetPreviewViewport,
): boolean {
  if (viewport.rowCount <= 0 || viewport.colCount <= 0) return false;
  return (
    row >= viewport.startRow &&
    row <= viewport.endRow &&
    col >= viewport.startCol &&
    col <= viewport.endCol
  );
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
  const fillColor =
    readOoxmlColor(fill?.fgColor) ??
    readOoxmlColor(fill?.bgColor) ??
    readOoxmlColor(style?.fgColor) ??
    readOoxmlColor(style?.bgColor);
  if (fillColor) result.fillColor = fillColor;
  const textColor = readOoxmlColor(font?.color);
  if (textColor) result.textColor = textColor;
  return Object.keys(result).length > 0 ? result : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
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
