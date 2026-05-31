import {
  BooleanNumber,
  CellValueType,
  HorizontalAlign,
  LocaleType,
  type ICellData,
  type IRange,
  type IStyleData,
  type IWorkbookData,
  type IWorksheetData,
} from "@univerjs/core";

import type {
  SpreadsheetBatchPatchOperation,
  SpreadsheetCellStyle,
  SpreadsheetCellStylePatch,
  SpreadsheetPreviewCell,
  SpreadsheetWorkbookSnapshot,
  SpreadsheetWorkbookSnapshotSheet,
} from "../../../../src/shared/spreadsheetPreview";

export type UniverSelectionContext = {
  sheetName: string;
  rangeA1: string;
  activeCellA1: string;
  activeValue: string;
  activeFormula?: string;
  activeStyle?: SpreadsheetCellStyle;
};

const MIN_UNIVER_ROWS = 100;
const MIN_UNIVER_COLS = 26;
const COWORK_WORKBOOK_VERSION = "3.0.0";
const DEFAULT_TEXT_COLOR = rgbHex(36, 41, 47);
const DEFAULT_GRID_COLOR = rgbHex(229, 231, 235);

type UniverCellMatrix = NonNullable<IWorksheetData["cellData"]>;
type UniverRowMatrix = NonNullable<IWorksheetData["rowData"]>;
type UniverColumnMatrix = NonNullable<IWorksheetData["columnData"]>;

export function spreadsheetSnapshotToUniverData(
  workbook: SpreadsheetWorkbookSnapshot,
): IWorkbookData {
  const styles: Record<string, IStyleData> = {};
  const styleIds = new Map<string, string>();
  const sheetOrder: string[] = [];
  const sheets: IWorkbookData["sheets"] = {};

  for (const sheet of workbook.sheets) {
    const sheetId = sheet.id;
    sheetOrder.push(sheetId);
    sheets[sheetId] = sheetSnapshotToUniverSheet(sheet, styles, styleIds);
  }

  return {
    id: `cowork-${stableId(workbook.path)}`,
    name: workbook.filename,
    appVersion: COWORK_WORKBOOK_VERSION,
    locale: LocaleType.EN_US,
    styles,
    sheetOrder,
    sheets,
    defaultStyle: {
      ff: "Aptos",
      fs: 11,
      cl: { rgb: DEFAULT_TEXT_COLOR },
    },
  };
}

export function diffUniverWorkbookPatches(
  previous: IWorkbookData,
  current: IWorkbookData,
): SpreadsheetBatchPatchOperation[] {
  const operations: SpreadsheetBatchPatchOperation[] = [];
  for (const sheetId of current.sheetOrder) {
    const currentSheet = current.sheets[sheetId];
    if (!currentSheet?.name) continue;
    const previousSheet = previous.sheets[sheetId];
    const coords = collectCellCoords(previousSheet?.cellData, currentSheet.cellData);

    for (const coord of coords) {
      const previousCell = readUniverCell(previousSheet?.cellData, coord.row, coord.col);
      const currentCell = readUniverCell(currentSheet.cellData, coord.row, coord.col);
      const address = addressFor(coord.row, coord.col);
      const previousInput = rawInputFromCellData(previousCell);
      const currentInput = rawInputFromCellData(currentCell);
      if (previousInput !== currentInput) {
        operations.push({
          type: "cell",
          sheetName: currentSheet.name,
          address,
          rawInput: currentInput,
        });
      }

      const previousStyle = stylePatchFromUniverStyle(resolveUniverStyle(previous, previousCell?.s));
      const currentStyle = stylePatchFromUniverStyle(resolveUniverStyle(current, currentCell?.s));
      const patch = stylePatchBetween(previousStyle, currentStyle);
      if (Object.keys(patch).length > 0) {
        operations.push({
          type: "format",
          sheetName: currentSheet.name,
          range: address,
          style: patch,
        });
      }
    }
  }
  return operations;
}

export function cloneUniverWorkbookData(workbook: IWorkbookData): IWorkbookData {
  return JSON.parse(JSON.stringify(workbook)) as IWorkbookData;
}

export function buildUniverSpreadsheetPrompt(opts: {
  path: string;
  workbook: SpreadsheetWorkbookSnapshot;
  selection: UniverSelectionContext | null;
  request: string;
}): string {
  const selectedSheet =
    opts.selection?.sheetName ??
    opts.workbook.activeSheetName ??
    opts.workbook.sheets[0]?.name ??
    "Sheet1";
  const selection = opts.selection;
  const feedbackMode = requestLooksLikeFeedback(opts.request)
    ? "answer_without_editing"
    : "edit_when_requested";
  const sheet = opts.workbook.sheets.find((candidate) => candidate.name === selectedSheet);
  const objectsXml = sheet ? workbookObjectsXml(sheet) : "";

  return `<spreadsheet_canvas_request version="2" source="univer">
  <assistant_instructions>
    <instruction>Treat this as structured context from Cowork's embedded Univer spreadsheet canvas.</instruction>
    <instruction mode="${feedbackMode}">${
      feedbackMode === "answer_without_editing"
        ? "The user is asking for feedback or analysis; answer directly unless they explicitly ask for file changes."
        : "If the user asks for workbook changes, edit the local workbook file and summarize the exact changes."
    }</instruction>
  </assistant_instructions>
  <workbook file_name="${escapeXml(opts.workbook.filename)}" path="${escapeXml(opts.path)}" kind="${
    opts.workbook.kind
  }">
    <active_sheet>${escapeXml(selectedSheet)}</active_sheet>
    <selection range="${escapeXml(selection?.rangeA1 ?? "")}" active_cell="${escapeXml(
      selection?.activeCellA1 ?? "",
    )}">
      <value>${escapeXml(selection?.activeValue ?? "")}</value>${
        selection?.activeFormula
          ? `\n      <formula>${escapeXml(selection.activeFormula)}</formula>`
          : ""
      }${
        selection?.activeStyle
          ? `\n      <style>${escapeXml(formatCellStyle(selection.activeStyle) ?? "")}</style>`
          : ""
      }
    </selection>${objectsXml ? `\n${objectsXml}` : ""}
  </workbook>
  <user_request>${escapeXml(opts.request)}</user_request>
</spreadsheet_canvas_request>`;
}

export function selectionContextFromWorkbook(
  snapshot: SpreadsheetWorkbookSnapshot,
  data: IWorkbookData,
  sheetName: string,
  range: IRange | null,
  activeCellA1: string | null,
): UniverSelectionContext | null {
  const sheet = snapshot.sheets.find((candidate) => candidate.name === sheetName);
  if (!sheet) return null;
  const activeCell = activeCellA1 ? cellByAddress(sheet, activeCellA1) : null;
  const rangeA1 = range ? rangeToA1(range) : (activeCellA1 ?? "A1");
  const currentCellData = cellDataBySheetName(
    data,
    sheetName,
    activeCellA1 ?? rangeA1.split(":")[0] ?? "A1",
  );
  const activeStyle =
    activeCell?.style ??
    styleFromUniverStyle(resolveUniverStyle(data, currentCellData?.s));
  const activeFormula =
    typeof currentCellData?.f === "string" && currentCellData.f.trim() !== ""
      ? rawInputFromCellData(currentCellData)
      : activeCell?.formula
        ? `=${activeCell.formula}`
        : undefined;

  return {
    sheetName,
    rangeA1,
    activeCellA1: activeCellA1 ?? rangeA1.split(":")[0] ?? "A1",
    activeValue: displayValueFromCellData(currentCellData) ?? activeCell?.value ?? "",
    ...(activeFormula ? { activeFormula } : {}),
    ...(activeStyle ? { activeStyle } : {}),
  };
}

function sheetSnapshotToUniverSheet(
  sheet: SpreadsheetWorkbookSnapshotSheet,
  styles: Record<string, IStyleData>,
  styleIds: Map<string, string>,
): Partial<IWorksheetData> {
  const cellData: UniverCellMatrix = {};
  for (const cell of sheet.cells) {
    const univerCell = previewCellToUniverCell(cell, styles, styleIds);
    if (Object.keys(univerCell).length === 0) continue;
    let row = cellData[cell.row];
    if (!row) {
      row = {};
      cellData[cell.row] = row;
    }
    row[cell.col] = univerCell;
  }

  const columnData: UniverColumnMatrix = {};
  for (const width of sheet.columnWidths) {
    const w = width.widthPx ?? (width.widthChars ? Math.round(width.widthChars * 8 + 24) : null);
    if (w) columnData[width.col] = { w };
  }

  return {
    id: sheet.id,
    name: sheet.name,
    tabColor: "",
    hidden: sheet.hidden ? BooleanNumber.TRUE : BooleanNumber.FALSE,
    freeze: { startRow: -1, startColumn: -1, ySplit: 0, xSplit: 0 },
    rowCount: Math.max(sheet.rowCount, MIN_UNIVER_ROWS),
    columnCount: Math.max(sheet.colCount, MIN_UNIVER_COLS),
    zoomRatio: 1,
    scrollTop: 0,
    scrollLeft: 0,
    defaultColumnWidth: 96,
    defaultRowHeight: 24,
    mergeData: sheet.mergedCells.map((merge) => ({
      startRow: merge.startRow,
      startColumn: merge.startCol,
      endRow: merge.endRow,
      endColumn: merge.endCol,
    })),
    cellData,
    rowData: {} satisfies UniverRowMatrix,
    columnData,
    rowHeader: { width: 44 },
    columnHeader: { height: 24 },
    showGridlines: BooleanNumber.TRUE,
    gridlinesColor: DEFAULT_GRID_COLOR,
    rightToLeft: BooleanNumber.FALSE,
  };
}

function previewCellToUniverCell(
  cell: SpreadsheetPreviewCell,
  styles: Record<string, IStyleData>,
  styleIds: Map<string, string>,
): ICellData {
  const data: ICellData = {};
  if (cell.formula) {
    data.f = `=${cell.formula}`;
    if (cell.rawValue !== undefined && cell.rawValue !== null) {
      data.v = cell.rawValue;
    }
  } else if (cell.rawValue !== undefined && cell.rawValue !== null) {
    data.v = cell.rawValue;
    data.t = cellValueTypeFor(cell.rawValue);
  } else if (cell.value) {
    data.v = cell.value;
    data.t = CellValueType.STRING;
  }

  if (cell.style) {
    data.s = styleIdFor(cell.style, styles, styleIds);
  }
  return data;
}

function cellValueTypeFor(value: string | number | boolean): CellValueType {
  if (typeof value === "number") return CellValueType.NUMBER;
  if (typeof value === "boolean") return CellValueType.BOOLEAN;
  return CellValueType.STRING;
}

function styleIdFor(
  style: SpreadsheetCellStyle,
  styles: Record<string, IStyleData>,
  styleIds: Map<string, string>,
): string {
  const univerStyle = styleToUniverStyle(style);
  const key = stableStringify(univerStyle);
  const existing = styleIds.get(key);
  if (existing) return existing;
  const id = `cowork-style-${styleIds.size + 1}`;
  styleIds.set(key, id);
  styles[id] = univerStyle;
  return id;
}

function styleToUniverStyle(style: SpreadsheetCellStyle): IStyleData {
  return {
    ...(style.bold ? { bl: BooleanNumber.TRUE } : {}),
    ...(style.italic ? { it: BooleanNumber.TRUE } : {}),
    ...(style.fontSize ? { fs: style.fontSize } : {}),
    ...(style.fillColor ? { bg: { rgb: normalizeHexColor(style.fillColor) } } : {}),
    ...(style.textColor ? { cl: { rgb: normalizeHexColor(style.textColor) } } : {}),
    ...(style.numberFormat ? { n: { pattern: style.numberFormat } } : {}),
    ...(style.horizontalAlign ? { ht: horizontalAlignToUniver(style.horizontalAlign) } : {}),
  };
}

function styleFromUniverStyle(style: IStyleData | null): SpreadsheetCellStyle | undefined {
  if (!style) return undefined;
  const result: SpreadsheetCellStyle = {
    ...(style.bl === BooleanNumber.TRUE ? { bold: true } : {}),
    ...(style.it === BooleanNumber.TRUE ? { italic: true } : {}),
    ...(typeof style.fs === "number" ? { fontSize: style.fs } : {}),
    ...(style.bg?.rgb ? { fillColor: normalizeHexColor(style.bg.rgb) } : {}),
    ...(style.cl?.rgb ? { textColor: normalizeHexColor(style.cl.rgb) } : {}),
    ...(style.n?.pattern ? { numberFormat: style.n.pattern } : {}),
    ...(style.ht ? { horizontalAlign: horizontalAlignFromUniver(style.ht) } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function stylePatchFromUniverStyle(style: IStyleData | null): SpreadsheetCellStylePatch {
  const normalized = styleFromUniverStyle(style);
  return {
    bold: normalized?.bold ?? null,
    italic: normalized?.italic ?? null,
    fontSize: normalized?.fontSize ?? null,
    fillColor: normalized?.fillColor ?? null,
    textColor: normalized?.textColor ?? null,
    horizontalAlign: normalized?.horizontalAlign ?? null,
  };
}

function stylePatchBetween(
  previous: SpreadsheetCellStylePatch,
  current: SpreadsheetCellStylePatch,
): SpreadsheetCellStylePatch {
  const patch: SpreadsheetCellStylePatch = {};
  if (previous.bold !== current.bold) patch.bold = current.bold;
  if (previous.italic !== current.italic) patch.italic = current.italic;
  if (previous.fontSize !== current.fontSize) patch.fontSize = current.fontSize;
  if (previous.fillColor !== current.fillColor) patch.fillColor = current.fillColor;
  if (previous.textColor !== current.textColor) patch.textColor = current.textColor;
  if (previous.horizontalAlign !== current.horizontalAlign) {
    patch.horizontalAlign = current.horizontalAlign;
  }
  return patch;
}

function resolveUniverStyle(
  workbook: IWorkbookData,
  styleRef: ICellData["s"] | undefined,
): IStyleData | null {
  if (!styleRef) return null;
  if (typeof styleRef === "string") return workbook.styles[styleRef] ?? null;
  return styleRef;
}

function collectCellCoords(
  previous: Partial<IWorksheetData>["cellData"] | undefined,
  current: Partial<IWorksheetData>["cellData"] | undefined,
): Array<{ row: number; col: number }> {
  const keys = new Set<string>();
  for (const matrix of [previous, current]) {
    if (!matrix) continue;
    for (const [rowKey, row] of Object.entries(matrix)) {
      if (!row) continue;
      for (const colKey of Object.keys(row)) {
        keys.add(`${rowKey}:${colKey}`);
      }
    }
  }
  return [...keys]
    .map((key) => {
      const [row, col] = key.split(":").map((part) => Number.parseInt(part, 10));
      return { row: Number.isFinite(row) ? row : 0, col: Number.isFinite(col) ? col : 0 };
    })
    .sort((left, right) => left.row - right.row || left.col - right.col);
}

function readUniverCell(
  matrix: Partial<IWorksheetData>["cellData"] | undefined,
  row: number,
  col: number,
): ICellData | undefined {
  return matrix?.[row]?.[col] ?? undefined;
}

function rawInputFromCellData(cell: ICellData | undefined): string {
  if (!cell) return "";
  if (typeof cell.f === "string" && cell.f.trim() !== "") {
    return cell.f.startsWith("=") ? cell.f : `=${cell.f}`;
  }
  if (cell.v === null || cell.v === undefined) return "";
  return String(cell.v);
}

function displayValueFromCellData(cell: ICellData | undefined): string | null {
  if (!cell) return null;
  if (cell.v === null || cell.v === undefined) return "";
  return String(cell.v);
}

function cellDataBySheetName(
  data: IWorkbookData,
  sheetName: string,
  address: string,
): ICellData | undefined {
  const sheet = Object.values(data.sheets).find((candidate) => candidate?.name === sheetName);
  if (!sheet) return undefined;
  const decoded = decodeAddress(address);
  return decoded ? readUniverCell(sheet.cellData, decoded.row, decoded.col) : undefined;
}

function cellByAddress(
  sheet: SpreadsheetWorkbookSnapshotSheet,
  address: string,
): SpreadsheetPreviewCell | undefined {
  return sheet.cells.find((cell) => cell.address === address.toUpperCase());
}

function requestLooksLikeFeedback(request: string): boolean {
  return /\b(what do you think|thoughts?|feedback|opinion|comment|review|analy[sz]e|assessment)\b/i.test(
    request,
  );
}

function workbookObjectsXml(sheet: SpreadsheetWorkbookSnapshotSheet): string {
  const lines: string[] = [];
  if (sheet.tables.length > 0) {
    lines.push(
      "    <tables>",
      ...sheet.tables.map(
        (table) => `      <table name="${escapeXml(table.name)}" ref="${escapeXml(table.ref)}" />`,
      ),
      "    </tables>",
    );
  }
  if (sheet.charts.length > 0) {
    lines.push(
      "    <charts>",
      ...sheet.charts.map(
        (chart) =>
          `      <chart id="${escapeXml(chart.id)}" title="${escapeXml(
            chart.title ?? "",
          )}" type="${escapeXml(chart.type ?? "")}" />`,
      ),
      "    </charts>",
    );
  }
  return lines.join("\n");
}

function formatCellStyle(style: SpreadsheetCellStyle | undefined): string | null {
  if (!style) return null;
  const parts = [
    style.bold ? "bold" : null,
    style.italic ? "italic" : null,
    style.fontSize ? `${style.fontSize}pt` : null,
    style.fillColor ? `fill ${style.fillColor}` : null,
    style.textColor ? `text ${style.textColor}` : null,
    style.horizontalAlign ? `align ${style.horizontalAlign}` : null,
    style.numberFormat ? `number format ${style.numberFormat}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : null;
}

function horizontalAlignToUniver(value: string): HorizontalAlign {
  const normalized = value.toLowerCase();
  if (normalized === "center") return HorizontalAlign.CENTER;
  if (normalized === "right") return HorizontalAlign.RIGHT;
  return HorizontalAlign.LEFT;
}

function horizontalAlignFromUniver(value: HorizontalAlign): string {
  if (value === HorizontalAlign.CENTER) return "center";
  if (value === HorizontalAlign.RIGHT) return "right";
  return "left";
}

function normalizeHexColor(value: string): string {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^#[0-9a-f]{8}$/i.test(trimmed)) return `#${trimmed.slice(3).toUpperCase()}`;
  return trimmed;
}

function rgbHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((component) => component.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

function rangeToA1(range: IRange): string {
  const start = addressFor(range.startRow, range.startColumn);
  const end = addressFor(range.endRow, range.endColumn);
  return start === end ? start : `${start}:${end}`;
}

function addressFor(row: number, col: number): string {
  return `${columnLabel(col)}${row + 1}`;
}

function decodeAddress(address: string): { row: number; col: number } | null {
  const match = /^([A-Z]+)([1-9][0-9]*)$/i.exec(address.trim());
  if (!match) return null;
  let col = 0;
  for (const ch of match[1].toUpperCase()) {
    col = col * 26 + (ch.charCodeAt(0) - 64);
  }
  return { row: Number.parseInt(match[2], 10) - 1, col: col - 1 };
}

function columnLabel(index: number): string {
  let current = index + 1;
  let label = "";
  while (current > 0) {
    const rem = (current - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    current = Math.floor((current - 1) / 26);
  }
  return label;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function stableId(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function escapeXml(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
