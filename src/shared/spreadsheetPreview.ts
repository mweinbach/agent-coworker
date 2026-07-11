import type { FileChangeVersion } from "./fileVersion";

export type SpreadsheetFileKind = "csv" | "xlsx";

export type SpreadsheetPreviewViewport = {
  startRow: number;
  startCol: number;
  rowCount: number;
  colCount: number;
  endRow: number;
  endCol: number;
  totalRows: number;
  totalCols: number;
  truncatedRows: boolean;
  truncatedCols: boolean;
};

export type SpreadsheetSheetSummary = {
  name: string;
  rowCount: number;
  colCount: number;
  hidden?: boolean;
};

export type SpreadsheetCellStyle = {
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
  horizontalAlign?: string;
  fillColor?: string;
  textColor?: string;
  numberFormat?: string;
};

export type SpreadsheetPreviewCell = {
  row: number;
  col: number;
  address: string;
  value: string;
  formattedValue?: string;
  rawValue?: string | number | boolean | null;
  formula?: string;
  type?: string;
  style?: SpreadsheetCellStyle;
};

export type SpreadsheetMergedRange = {
  ref: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
};

export type SpreadsheetColumnWidth = {
  col: number;
  widthChars?: number;
  widthPx?: number;
};

export type SpreadsheetTableSummary = {
  name: string;
  ref: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
};

export type SpreadsheetChartAnchor = {
  fromRow?: number;
  fromCol?: number;
  toRow?: number;
  toCol?: number;
};

export type SpreadsheetChartSummary = {
  id: string;
  title?: string;
  type?: string;
  anchor?: SpreadsheetChartAnchor;
};

type SpreadsheetWorkbookFailure = {
  ok: false;
  error: {
    kind:
      | "unsupported_format"
      | "not_found"
      | "outside_workspace"
      | "parse_error"
      | "empty_workbook";
    message: string;
  };
  warnings: string[];
};

// ---- Full-workbook snapshot (Univer canvas source) ----

export type SpreadsheetFileVersion = FileChangeVersion;

export type SpreadsheetFileVersionResult =
  | { ok: true; version: SpreadsheetFileVersion }
  | {
      ok: false;
      error: {
        kind: "unsupported_format" | "not_found" | "outside_workspace" | "parse_error";
        message: string;
      };
      warnings: string[];
    };

export type SpreadsheetWorkbookSnapshotSheet = SpreadsheetSheetSummary & {
  id: string;
  loadedRowCount?: number;
  loadedColCount?: number;
  truncatedRows?: boolean;
  truncatedCols?: boolean;
  cells: SpreadsheetPreviewCell[];
  mergedCells: SpreadsheetMergedRange[];
  columnWidths: SpreadsheetColumnWidth[];
  tables: SpreadsheetTableSummary[];
  charts: SpreadsheetChartSummary[];
};

export type SpreadsheetWorkbookSnapshot = {
  kind: SpreadsheetFileKind;
  path: string;
  filename: string;
  fileVersion: SpreadsheetFileVersion;
  sheets: SpreadsheetWorkbookSnapshotSheet[];
  activeSheetName: string;
  warnings: string[];
};

type SpreadsheetWorkbookSnapshotSuccess = {
  ok: true;
  workbook: SpreadsheetWorkbookSnapshot;
};

type SpreadsheetWorkbookSnapshotFailure = SpreadsheetWorkbookFailure;

export type SpreadsheetWorkbookSnapshotResult =
  | SpreadsheetWorkbookSnapshotSuccess
  | SpreadsheetWorkbookSnapshotFailure;

// ---- Single-cell edit (write-back) ----

export type SpreadsheetCellEditRequest = {
  cwd: string;
  filePath: string;
  /** Ignored for CSV (single sheet). Defaults to the first sheet for XLSX. */
  sheetName?: string;
  /** A1-style address, e.g. "B2". */
  address: string;
  /**
   * Exactly what the user typed. The server infers the cell type for XLSX
   * (leading "=" → formula, numeric → number, empty → blank, else text). CSV
   * stores the string verbatim.
   */
  rawInput: string;
};

export type SpreadsheetCellEditFailureKind =
  | "unsupported_format"
  | "not_found"
  | "outside_workspace"
  | "parse_error"
  | "write_error";

export type SpreadsheetCellEditResult =
  | { ok: true }
  | { ok: false; error: { kind: SpreadsheetCellEditFailureKind; message: string } };

// ---- Range formatting (write-back) ----

export type SpreadsheetCellStylePatch = {
  bold?: boolean | null;
  italic?: boolean | null;
  fontSize?: number | null;
  horizontalAlign?: string | null;
  fillColor?: string | null;
  textColor?: string | null;
  numberFormat?: string | null;
};

export type SpreadsheetRangeFormatRequest = {
  cwd: string;
  filePath: string;
  /** Defaults to the first sheet for XLSX. */
  sheetName?: string;
  /** A1-style cell or range, e.g. "B2" or "A1:C4". */
  range: string;
  style: SpreadsheetCellStylePatch;
};

export type SpreadsheetRangeFormatResult =
  | { ok: true }
  | { ok: false; error: { kind: SpreadsheetCellEditFailureKind; message: string } };

// ---- Batched workbook patches (Univer save bridge) ----

export type SpreadsheetBatchPatchCellOperation = {
  type: "cell";
  sheetName?: string;
  address: string;
  rawInput: string;
};

export type SpreadsheetBatchPatchFormatOperation = {
  type: "format";
  sheetName?: string;
  range: string;
  style: SpreadsheetCellStylePatch;
};

export type SpreadsheetBatchPatchMergeOperation = {
  type: "merge";
  sheetName?: string;
  range: string;
  merged: boolean;
};

export type SpreadsheetBatchPatchColumnWidthOperation = {
  type: "columnWidth";
  sheetName?: string;
  col: number;
  widthPx: number | null;
};

export type SpreadsheetBatchPatchOperation =
  | SpreadsheetBatchPatchCellOperation
  | SpreadsheetBatchPatchFormatOperation
  | SpreadsheetBatchPatchMergeOperation
  | SpreadsheetBatchPatchColumnWidthOperation;

export type SpreadsheetBatchPatchRequest = {
  cwd: string;
  filePath: string;
  operations: SpreadsheetBatchPatchOperation[];
  expectedFileVersion?: SpreadsheetFileVersion;
};

export type SpreadsheetBatchPatchResult = SpreadsheetRangeFormatResult;
