export const SPREADSHEET_PREVIEW_DEFAULT_ROW_COUNT = 200;
export const SPREADSHEET_PREVIEW_DEFAULT_COL_COUNT = 40;
export const SPREADSHEET_PREVIEW_MAX_ROW_COUNT = 500;
export const SPREADSHEET_PREVIEW_MAX_COL_COUNT = 100;

export type SpreadsheetFileKind = "csv" | "xlsx";

export type SpreadsheetPreviewViewportRequest = {
  startRow?: number;
  startCol?: number;
  rowCount?: number;
  colCount?: number;
};

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

export type SpreadsheetPreview = {
  kind: SpreadsheetFileKind;
  path: string;
  filename: string;
  sheets: SpreadsheetSheetSummary[];
  selectedSheetName: string;
  viewport: SpreadsheetPreviewViewport;
  cells: SpreadsheetPreviewCell[][];
  mergedCells: SpreadsheetMergedRange[];
  columnWidths: SpreadsheetColumnWidth[];
  tables: SpreadsheetTableSummary[];
  charts: SpreadsheetChartSummary[];
  warnings: string[];
};

type SpreadsheetPreviewSuccess = {
  ok: true;
  preview: SpreadsheetPreview;
};

type SpreadsheetPreviewFailure = {
  ok: false;
  error: {
    kind: "unsupported_format" | "parse_error" | "empty_workbook";
    message: string;
  };
  warnings: string[];
};

export type SpreadsheetPreviewResult = SpreadsheetPreviewSuccess | SpreadsheetPreviewFailure;

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
  | "parse_error"
  | "write_error";

export type SpreadsheetCellEditResult =
  | { ok: true }
  | { ok: false; error: { kind: SpreadsheetCellEditFailureKind; message: string } };
