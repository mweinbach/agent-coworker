import fs from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import * as XLSX from "xlsx";

import {
  SPREADSHEET_PREVIEW_DEFAULT_COL_COUNT,
  SPREADSHEET_PREVIEW_DEFAULT_ROW_COUNT,
  SPREADSHEET_PREVIEW_MAX_COL_COUNT,
  SPREADSHEET_PREVIEW_MAX_ROW_COUNT,
  type SpreadsheetCellStyle,
  type SpreadsheetChartSummary,
  type SpreadsheetColumnWidth,
  type SpreadsheetFileKind,
  type SpreadsheetMergedRange,
  type SpreadsheetPreview,
  type SpreadsheetPreviewCell,
  type SpreadsheetPreviewResult,
  type SpreadsheetTableSummary,
  type SpreadsheetPreviewViewport,
  type SpreadsheetPreviewViewportRequest,
  type SpreadsheetWorkbookSnapshot,
  type SpreadsheetWorkbookSnapshotResult,
  type SpreadsheetWorkbookSnapshotSheet,
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
    let preview = buildSpreadsheetPreview({
      workbook,
      kind,
      filePath: resolvedPath,
      requestedSheetName: request.sheetName,
      requestedViewport: request.viewport,
    });
    if (kind === "xlsx") {
      try {
        const packageDetails = await readXlsxSheetObjects(bytes, preview.selectedSheetName);
        preview = {
          ...preview,
          tables: packageDetails.tables,
          charts: packageDetails.charts,
          cells: mergePackageCellStyles(preview.cells, packageDetails.cellStyles),
        };
      } catch (metadataError) {
        preview = {
          ...preview,
          warnings: [
            ...preview.warnings,
            `Workbook objects could not be read: ${
              metadataError instanceof Error ? metadataError.message : String(metadataError)
            }`,
          ],
        };
      }
    }
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

export async function readSpreadsheetWorkbookSnapshot(
  request: SpreadsheetPreviewRequest,
): Promise<SpreadsheetWorkbookSnapshotResult> {
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

  try {
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
      requestedSheetName: request.sheetName,
    });
    return { ok: true, workbook: snapshot };
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
    tables: [],
    charts: [],
    warnings: buildWarnings(selectedSummary, viewport),
  };
}

async function buildSpreadsheetWorkbookSnapshot(opts: {
  workbook: Workbook;
  kind: SpreadsheetFileKind;
  filePath: string;
  bytes: Buffer;
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

function mergePackageCellStyles(
  cells: SpreadsheetPreviewCell[][],
  packageStyles: Map<string, SpreadsheetCellStyle>,
): SpreadsheetPreviewCell[][] {
  if (packageStyles.size === 0) return cells;
  return cells.map((row) =>
    row.map((cell) => {
      const style = packageStyles.get(cell.address);
      if (!style) return cell;
      return {
        ...cell,
        style: {
          ...cell.style,
          ...style,
        },
      };
    }),
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
    readColor(fill?.fgColor) ??
    readColor(fill?.bgColor) ??
    readColor(style?.fgColor) ??
    readColor(style?.bgColor);
  if (fillColor) result.fillColor = fillColor;
  const textColor = readColor(font?.color);
  if (textColor) result.textColor = textColor;
  return Object.keys(result).length > 0 ? result : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

const EXCEL_INDEXED_COLORS: Record<number, string> = {
  0: "#000000",
  1: "#FFFFFF",
  2: "#FF0000",
  3: "#00FF00",
  4: "#0000FF",
  5: "#FFFF00",
  6: "#FF00FF",
  7: "#00FFFF",
  8: "#000000",
  9: "#FFFFFF",
  10: "#FF0000",
  11: "#00FF00",
  12: "#0000FF",
  13: "#FFFF00",
  14: "#FF00FF",
  15: "#00FFFF",
  16: "#800000",
  17: "#008000",
  18: "#000080",
  19: "#808000",
  20: "#800080",
  21: "#008080",
  22: "#C0C0C0",
  23: "#808080",
  24: "#9999FF",
  25: "#993366",
  26: "#FFFFCC",
  27: "#CCFFFF",
  28: "#660066",
  29: "#FF8080",
  30: "#0066CC",
  31: "#CCCCFF",
  32: "#000080",
  33: "#FF00FF",
  34: "#FFFF00",
  35: "#00FFFF",
  36: "#800080",
  37: "#800000",
  38: "#008080",
  39: "#0000FF",
  40: "#00CCFF",
  41: "#CCFFFF",
  42: "#CCFFCC",
  43: "#FFFF99",
  44: "#99CCFF",
  45: "#FF99CC",
  46: "#CC99FF",
  47: "#FFCC99",
  48: "#3366FF",
  49: "#33CCCC",
  50: "#99CC00",
  51: "#FFCC00",
  52: "#FF9900",
  53: "#FF6600",
  54: "#666699",
  55: "#969696",
  56: "#003366",
  57: "#339966",
  58: "#003300",
  59: "#333300",
  60: "#993300",
  61: "#993366",
  62: "#333399",
  63: "#333333",
};

const DEFAULT_EXCEL_THEME_COLORS = [
  "#FFFFFF",
  "#000000",
  "#EEECE1",
  "#1F497D",
  "#4F81BD",
  "#C0504D",
  "#9BBB59",
  "#8064A2",
  "#4BACC6",
  "#F79646",
];

function readColor(value: unknown): string | null {
  const record = readRecord(value);
  const rgb = typeof record?.rgb === "string" ? record.rgb : null;
  if (rgb) {
    const normalized = rgb.length === 8 ? rgb.slice(2) : rgb;
    return /^[0-9a-fA-F]{6}$/.test(normalized) ? `#${normalized.toUpperCase()}` : null;
  }

  const indexed = readNumber(record?.indexed);
  if (indexed !== null) {
    return EXCEL_INDEXED_COLORS[indexed] ?? null;
  }

  const themeIndex = readNumber(record?.theme);
  if (themeIndex !== null) {
    const themeColor = DEFAULT_EXCEL_THEME_COLORS[themeIndex];
    if (!themeColor) return null;
    const tint = readNumber(record?.tint);
    return tint === null ? themeColor : applyColorTint(themeColor, tint);
  }

  return null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function applyColorTint(hexColor: string, tint: number): string {
  const rgb = hexColor.replace("#", "");
  const parts = [0, 2, 4].map((start) => Number.parseInt(rgb.slice(start, start + 2), 16));
  const tinted = parts.map((part) => {
    const next = tint < 0 ? part * (1 + tint) : part + (255 - part) * tint;
    return Math.min(255, Math.max(0, Math.round(next)));
  });
  return `#${tinted
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
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

type XmlRecord = Record<string, unknown>;

type XlsxRelationship = {
  id: string;
  type: string;
  target: string;
};

type XlsxSheetObjects = {
  tables: SpreadsheetTableSummary[];
  charts: SpreadsheetChartSummary[];
  cellStyles: Map<string, SpreadsheetCellStyle>;
};

const OOXML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
});

async function readXlsxSheetObjects(bytes: Buffer, sheetName: string): Promise<XlsxSheetObjects> {
  const zip = await JSZip.loadAsync(bytes);
  const worksheetPart = await resolvePreviewWorksheetPart(zip, sheetName);
  if (!worksheetPart) return { tables: [], charts: [], cellStyles: new Map() };

  const worksheetRoot = await readXmlPart(zip, worksheetPart);
  const worksheet = asRecord(worksheetRoot?.worksheet);
  if (!worksheet) return { tables: [], charts: [], cellStyles: new Map() };

  const relationships = await readRelationships(zip, worksheetPart);
  const cellStyles = await readSheetCellStyles(zip, worksheet);
  const tables = await readSheetTables(zip, worksheet, relationships, worksheetPart);
  const charts = await readSheetCharts(zip, worksheet, relationships, worksheetPart);
  return { tables, charts, cellStyles };
}

async function resolvePreviewWorksheetPart(zip: JSZip, sheetName: string): Promise<string | null> {
  const workbookRoot = await readXmlPart(zip, "xl/workbook.xml");
  const workbook = asRecord(workbookRoot?.workbook);
  const sheetsNode = asRecord(workbook?.sheets);
  const sheets = arrayOfRecords(sheetsNode?.sheet);
  const selectedSheet = sheets.find((sheet) => stringValue(sheet.name) === sheetName);
  const relationshipId = stringValue(selectedSheet?.id);
  if (!relationshipId) return null;

  const workbookRelationships = await readRelationships(zip, "xl/workbook.xml");
  const relationship = workbookRelationships.get(relationshipId);
  if (!relationship) return null;
  return resolveRelationshipTarget("xl/workbook.xml", relationship.target);
}

type XlsxStyleTables = {
  fonts: XmlRecord[];
  fills: XmlRecord[];
  cellXfs: XmlRecord[];
  numberFormats: Map<number, string>;
};

async function readSheetCellStyles(
  zip: JSZip,
  worksheet: XmlRecord,
): Promise<Map<string, SpreadsheetCellStyle>> {
  const styles = await readStyleTables(zip);
  if (!styles) return new Map();

  const byAddress = new Map<string, SpreadsheetCellStyle>();
  const rows = arrayOfRecords(asRecord(worksheet.sheetData)?.row);
  for (const row of rows) {
    for (const cell of arrayOfRecords(row.c)) {
      const address = stringValue(cell.r);
      const styleIndex = readInteger(cell.s);
      if (!address || styleIndex === null) continue;
      const style = readStyleFromXf(styles, styleIndex);
      if (style) byAddress.set(address, style);
    }
  }
  return byAddress;
}

async function readStyleTables(zip: JSZip): Promise<XlsxStyleTables | null> {
  const stylesRoot = await readXmlPart(zip, "xl/styles.xml");
  const styleSheet = asRecord(stylesRoot?.styleSheet);
  if (!styleSheet) return null;

  const fonts = arrayOfRecords(asRecord(styleSheet.fonts)?.font);
  const fills = arrayOfRecords(asRecord(styleSheet.fills)?.fill);
  const cellXfs = arrayOfRecords(asRecord(styleSheet.cellXfs)?.xf);
  const numberFormats = new Map<number, string>();
  for (const numberFormat of arrayOfRecords(asRecord(styleSheet.numFmts)?.numFmt)) {
    const id = readInteger(numberFormat.numFmtId);
    const format = stringValue(numberFormat.formatCode);
    if (id !== null && format) numberFormats.set(id, format);
  }

  return { fonts, fills, cellXfs, numberFormats };
}

function readStyleFromXf(
  styles: XlsxStyleTables,
  styleIndex: number,
): SpreadsheetCellStyle | undefined {
  const xf = styles.cellXfs[styleIndex];
  if (!xf) return undefined;

  const font = styles.fonts[readInteger(xf.fontId) ?? -1];
  const fill = styles.fills[readInteger(xf.fillId) ?? -1];
  const patternFill = asRecord(fill?.patternFill);
  const alignment = asRecord(xf.alignment);
  const numberFormatId = readInteger(xf.numFmtId);
  const fontSize = readNodeNumber(font?.sz);
  const result: SpreadsheetCellStyle = {
    ...(font && xmlToggleIsOn(font.b) ? { bold: true } : {}),
    ...(font && xmlToggleIsOn(font.i) ? { italic: true } : {}),
    ...(fontSize !== null ? { fontSize } : {}),
    ...(typeof alignment?.horizontal === "string" ? { horizontalAlign: alignment.horizontal } : {}),
    ...(numberFormatId !== null && styles.numberFormats.has(numberFormatId)
      ? { numberFormat: styles.numberFormats.get(numberFormatId) }
      : {}),
  };

  const fillColor =
    readColor(patternFill?.fgColor) ??
    readColor(patternFill?.bgColor) ??
    readColor(fill?.fgColor) ??
    readColor(fill?.bgColor);
  if (fillColor) result.fillColor = fillColor;

  const textColor = readColor(font?.color);
  if (textColor) result.textColor = textColor;

  return Object.keys(result).length > 0 ? result : undefined;
}

function xmlToggleIsOn(value: unknown): boolean {
  if (value === undefined) return false;
  const record = asRecord(value);
  const raw = stringValue(record?.val ?? value);
  return raw !== "0" && raw !== "false";
}

async function readSheetTables(
  zip: JSZip,
  worksheet: XmlRecord,
  relationships: Map<string, XlsxRelationship>,
  worksheetPart: string,
): Promise<SpreadsheetTableSummary[]> {
  const tableParts = arrayOfRecords(asRecord(worksheet.tableParts)?.tablePart);
  const tables: SpreadsheetTableSummary[] = [];
  for (const tablePart of tableParts) {
    const relationshipId = stringValue(tablePart.id);
    const relationship = relationshipId ? relationships.get(relationshipId) : undefined;
    if (!relationship?.type.includes("/table")) continue;
    const resolvedPart = resolveRelationshipTarget(worksheetPart, relationship.target);
    const table = await readTableSummary(zip, resolvedPart);
    if (table) tables.push(table);
  }
  return tables;
}

async function readTableSummary(
  zip: JSZip,
  tablePart: string,
): Promise<SpreadsheetTableSummary | null> {
  const tableRoot = await readXmlPart(zip, tablePart);
  const table = asRecord(tableRoot?.table);
  const ref = stringValue(table?.ref);
  if (!ref) return null;
  const range = decodeA1Range(ref);
  if (!range) return null;
  return {
    name:
      stringValue(table?.displayName) ?? stringValue(table?.name) ?? path.posix.basename(tablePart),
    ref,
    ...range,
  };
}

async function readSheetCharts(
  zip: JSZip,
  worksheet: XmlRecord,
  relationships: Map<string, XlsxRelationship>,
  worksheetPart: string,
): Promise<SpreadsheetChartSummary[]> {
  const drawings = arrayOfRecords(worksheet.drawing);
  const charts: SpreadsheetChartSummary[] = [];
  for (const drawing of drawings) {
    const relationshipId = stringValue(drawing.id);
    const relationship = relationshipId ? relationships.get(relationshipId) : undefined;
    if (!relationship?.type.includes("/drawing")) continue;
    const drawingPart = resolveRelationshipTarget(worksheetPart, relationship.target);
    charts.push(...(await readDrawingCharts(zip, drawingPart)));
  }
  return charts;
}

async function readDrawingCharts(
  zip: JSZip,
  drawingPart: string,
): Promise<SpreadsheetChartSummary[]> {
  const drawingRoot = await readXmlPart(zip, drawingPart);
  const root = asRecord(drawingRoot?.wsDr) ?? asRecord(drawingRoot);
  if (!root) return [];

  const relationships = await readRelationships(zip, drawingPart);
  const anchors = [
    ...arrayOfRecords(root.twoCellAnchor),
    ...arrayOfRecords(root.oneCellAnchor),
    ...arrayOfRecords(root.absoluteAnchor),
  ];
  const charts: SpreadsheetChartSummary[] = [];
  for (const anchor of anchors) {
    const relationshipId = findChartRelationshipId(anchor);
    const relationship = relationshipId ? relationships.get(relationshipId) : undefined;
    if (!relationship?.type.includes("/chart")) continue;
    const chartPart = resolveRelationshipTarget(drawingPart, relationship.target);
    const metadata = await readChartMetadata(zip, chartPart);
    charts.push({
      id: path.posix.basename(chartPart, ".xml"),
      ...metadata,
      ...(readChartAnchor(anchor) ? { anchor: readChartAnchor(anchor) } : {}),
    });
  }
  return charts;
}

async function readChartMetadata(
  zip: JSZip,
  chartPart: string,
): Promise<Pick<SpreadsheetChartSummary, "title" | "type">> {
  const chartRoot = await readXmlPart(zip, chartPart);
  const chartSpace = asRecord(chartRoot?.chartSpace);
  const chart = asRecord(chartSpace?.chart);
  const title = normalizeWhitespace(collectTextValues(chart?.title).join(" "));
  const plotArea = asRecord(chart?.plotArea);
  const chartType = plotArea
    ? Object.keys(plotArea).find((key) => key !== "date1904" && key.endsWith("Chart"))
    : undefined;
  return {
    ...(title ? { title } : {}),
    ...(chartType ? { type: chartType.replace(/Chart$/, "") } : {}),
  };
}

function readChartAnchor(anchor: XmlRecord): SpreadsheetChartSummary["anchor"] | undefined {
  const from = readAnchorPoint(asRecord(anchor.from));
  const to = readAnchorPoint(asRecord(anchor.to));
  if (!from && !to) return undefined;
  return {
    ...(from?.row !== undefined ? { fromRow: from.row } : {}),
    ...(from?.col !== undefined ? { fromCol: from.col } : {}),
    ...(to?.row !== undefined ? { toRow: to.row } : {}),
    ...(to?.col !== undefined ? { toCol: to.col } : {}),
  };
}

function readAnchorPoint(point: XmlRecord | null): { row?: number; col?: number } | null {
  if (!point) return null;
  const row = readInteger(point.row);
  const col = readInteger(point.col);
  if (row === null && col === null) return null;
  return {
    ...(row !== null ? { row } : {}),
    ...(col !== null ? { col } : {}),
  };
}

async function readRelationships(
  zip: JSZip,
  ownerPart: string,
): Promise<Map<string, XlsxRelationship>> {
  const relsRoot = await readXmlPart(zip, relationshipPartPath(ownerPart));
  const relsNode = asRecord(relsRoot?.Relationships);
  const relationships = new Map<string, XlsxRelationship>();
  for (const relationship of arrayOfRecords(relsNode?.Relationship)) {
    const id = stringValue(relationship.Id);
    const type = stringValue(relationship.Type);
    const target = stringValue(relationship.Target);
    if (!id || !type || !target) continue;
    relationships.set(id, { id, type, target });
  }
  return relationships;
}

async function readXmlPart(zip: JSZip, partPath: string): Promise<XmlRecord | null> {
  const file = zip.file(partPath);
  if (!file) return null;
  return asRecord(OOXML_PARSER.parse(await file.async("string")));
}

function relationshipPartPath(ownerPart: string): string {
  const directory = path.posix.dirname(ownerPart);
  const filename = path.posix.basename(ownerPart);
  return normalizeZipPath(path.posix.join(directory, "_rels", `${filename}.rels`));
}

function resolveRelationshipTarget(ownerPart: string, target: string): string {
  if (target.startsWith("/")) return normalizeZipPath(target.slice(1));
  return normalizeZipPath(path.posix.join(path.posix.dirname(ownerPart), target));
}

function normalizeZipPath(input: string): string {
  const parts: string[] = [];
  for (const segment of input.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

function arrayOfRecords(value: unknown): XmlRecord[] {
  if (Array.isArray(value)) {
    return value.map(asRecord).filter((record): record is XmlRecord => record !== null);
  }
  const record = asRecord(value);
  return record ? [record] : [];
}

function asRecord(value: unknown): XmlRecord | null {
  return typeof value === "object" && value !== null ? (value as XmlRecord) : null;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function readInteger(value: unknown): number | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readNodeNumber(value: unknown): number | null {
  const record = asRecord(value);
  const raw = stringValue(record?.val ?? value);
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function decodeA1Range(
  ref: string,
): Pick<SpreadsheetTableSummary, "startRow" | "startCol" | "endRow" | "endCol"> | null {
  try {
    const range = XLSX.utils.decode_range(ref);
    return {
      startRow: range.s.r,
      startCol: range.s.c,
      endRow: range.e.r,
      endCol: range.e.c,
    };
  } catch {
    return null;
  }
}

function findChartRelationshipId(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findChartRelationshipId(item);
      if (found) return found;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const chartNode = asRecord(record.chart);
  const chartId = stringValue(chartNode?.id);
  if (chartId) return chartId;
  for (const child of Object.values(record)) {
    const found = findChartRelationshipId(child);
    if (found) return found;
  }
  return null;
}

function collectTextValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectTextValues);
  const record = asRecord(value);
  if (!record) return [];
  const ownText = stringValue(record.t);
  return [
    ...(ownText ? [ownText] : []),
    ...Object.entries(record)
      .filter(([key]) => key !== "t")
      .flatMap(([, child]) => collectTextValues(child)),
  ];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
