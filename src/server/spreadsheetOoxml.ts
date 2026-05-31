import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import type {
  SpreadsheetCellStyle,
  SpreadsheetChartSummary,
  SpreadsheetTableSummary,
} from "../shared/spreadsheetPreview";

export type XmlRecord = Record<string, unknown>;

export type XlsxRelationship = {
  id: string;
  type: string;
  target: string;
};

export type XlsxSheetObjects = {
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

export async function readXlsxSheetObjects(
  bytes: Buffer,
  sheetName: string,
): Promise<XlsxSheetObjects> {
  const zip = await JSZip.loadAsync(bytes);
  const worksheetPart = await resolveWorksheetPart(zip, sheetName);
  if (!worksheetPart) return emptySheetObjects();

  const worksheetRoot = await readXmlPart(zip, worksheetPart);
  const worksheet = asRecord(worksheetRoot?.worksheet);
  if (!worksheet) return emptySheetObjects();

  const relationships = await readRelationships(zip, worksheetPart);
  const cellStyles = await readSheetCellStyles(zip, worksheet);
  const tables = await readSheetTables(zip, worksheet, relationships, worksheetPart);
  const charts = await readSheetCharts(zip, worksheet, relationships, worksheetPart);
  return { tables, charts, cellStyles };
}

function emptySheetObjects(): XlsxSheetObjects {
  return { tables: [], charts: [], cellStyles: new Map() };
}

export async function resolveWorksheetPart(
  zip: JSZip,
  sheetName?: string,
): Promise<string | null> {
  const workbookRoot = await readXmlPart(zip, "xl/workbook.xml");
  const workbook = asRecord(workbookRoot?.workbook);
  const sheetsNode = asRecord(workbook?.sheets);
  const sheets = arrayOfRecords(sheetsNode?.sheet);
  if (sheets.length === 0) return null;

  const selectedSheet = sheetName
    ? sheets.find((sheet) => stringValue(sheet.name) === sheetName)
    : sheets[0];
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
    readOoxmlColor(patternFill?.fgColor) ??
    readOoxmlColor(patternFill?.bgColor) ??
    readOoxmlColor(fill?.fgColor) ??
    readOoxmlColor(fill?.bgColor);
  if (fillColor) result.fillColor = fillColor;

  const textColor = readOoxmlColor(font?.color);
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
    name: stringValue(table?.displayName) ?? stringValue(table?.name) ?? path.posix.basename(tablePart),
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
    const chartAnchor = readChartAnchor(anchor);
    charts.push({
      id: path.posix.basename(chartPart, ".xml"),
      ...metadata,
      ...(chartAnchor ? { anchor: chartAnchor } : {}),
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

export async function readRelationships(
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

export async function readXmlPart(zip: JSZip, partPath: string): Promise<XmlRecord | null> {
  const file = zip.file(partPath);
  if (!file) return null;
  return asRecord(OOXML_PARSER.parse(await file.async("string")));
}

function relationshipPartPath(ownerPart: string): string {
  const directory = path.posix.dirname(ownerPart);
  const filename = path.posix.basename(ownerPart);
  return normalizeZipPath(path.posix.join(directory, "_rels", `${filename}.rels`));
}

export function resolveRelationshipTarget(ownerPart: string, target: string): string {
  if (target.startsWith("/")) return normalizeZipPath(target.slice(1));
  return normalizeZipPath(path.posix.join(path.posix.dirname(ownerPart), target));
}

export function normalizeZipPath(input: string): string {
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

export function arrayOfRecords(value: unknown): XmlRecord[] {
  if (Array.isArray(value)) {
    return value.map(asRecord).filter((record): record is XmlRecord => record !== null);
  }
  const record = asRecord(value);
  return record ? [record] : [];
}

export function asRecord(value: unknown): XmlRecord | null {
  return typeof value === "object" && value !== null ? (value as XmlRecord) : null;
}

export function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function readInteger(value: unknown): number | null {
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
    const range = decodeRange(ref);
    return {
      startRow: range.startRow,
      startCol: range.startCol,
      endRow: range.endRow,
      endCol: range.endCol,
    };
  } catch {
    return null;
  }
}

function decodeRange(ref: string): {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
} {
  const [startRef, endRef = startRef] = ref.split(":");
  const start = decodeAddress(startRef ?? "");
  const end = decodeAddress(endRef ?? "");
  if (!start || !end) throw new Error(`Invalid range: ${ref}`);
  return {
    startRow: Math.min(start.row, end.row),
    startCol: Math.min(start.col, end.col),
    endRow: Math.max(start.row, end.row),
    endCol: Math.max(start.col, end.col),
  };
}

function decodeAddress(address: string): { row: number; col: number } | null {
  const match = /^([A-Z]+)([1-9][0-9]*)$/i.exec(address.trim());
  if (!match) return null;
  const [, colRef = "", rowRef = ""] = match;
  let col = 0;
  for (const ch of colRef.toUpperCase()) {
    col = col * 26 + (ch.charCodeAt(0) - 64);
  }
  return { row: Number.parseInt(rowRef, 10) - 1, col: col - 1 };
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

export function readOoxmlColor(value: unknown): string | null {
  const record = asRecord(value);
  const rgb = typeof record?.rgb === "string" ? record.rgb : null;
  if (rgb) {
    const normalized = rgb.length === 8 ? rgb.slice(2) : rgb;
    return /^[0-9a-fA-F]{6}$/.test(normalized) ? `#${normalized.toUpperCase()}` : null;
  }

  const indexed = readNumber(record?.indexed);
  if (indexed !== null) return EXCEL_INDEXED_COLORS[indexed] ?? null;

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
