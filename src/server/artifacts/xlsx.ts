import * as XLSX from "xlsx";

import type { SpreadsheetCellStyle } from "../../shared/spreadsheetPreview";
import { readXlsxSheetObjects } from "../spreadsheetOoxml";
import { artifactBuffer, loadBoundedOoxmlPackage } from "./ooxml";
import type { XlsxCell, XlsxColumnWidth, XlsxSheet, XlsxSnapshot } from "./types";

const MAX_CELLS = 1_000_000;

export async function extractXlsxSnapshot(bytes: Uint8Array): Promise<XlsxSnapshot> {
  await loadBoundedOoxmlPackage(bytes);
  const buffer = artifactBuffer({ bytes, filename: "workbook.xlsx" });
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellDates: true,
    cellFormula: true,
    cellNF: true,
    cellStyles: true,
    raw: true,
  });
  if (workbook.SheetNames.length === 0) {
    throw new Error("XLSX package does not contain any worksheets.");
  }

  let cellCount = 0;
  const sheets: XlsxSheet[] = [];
  for (const [index, name] of workbook.SheetNames.entries()) {
    const worksheet = workbook.Sheets[name];
    if (!worksheet) continue;
    const objects = await readXlsxSheetObjects(buffer, name);
    const cellsByAddress = new Map<string, XlsxCell>();
    for (const key of Object.keys(worksheet)) {
      if (key.startsWith("!") || !isCellAddress(key)) continue;
      const address = key.toUpperCase();
      const cell = worksheet[key] as XLSX.CellObject;
      cellsByAddress.set(address, {
        address,
        value: normalizeCellValue(cell.v),
        formula: typeof cell.f === "string" ? cell.f : null,
        style: normalizeCellStyle(cell, objects.cellStyles.get(address)),
      });
    }
    for (const [address, style] of objects.cellStyles) {
      const normalizedAddress = address.toUpperCase();
      const existing = cellsByAddress.get(normalizedAddress);
      cellsByAddress.set(normalizedAddress, {
        address: normalizedAddress,
        value: existing?.value ?? null,
        formula: existing?.formula ?? null,
        style: normalizeCellStyle(undefined, style),
      });
    }
    cellCount += cellsByAddress.size;
    if (cellCount > MAX_CELLS) {
      throw new Error(`XLSX package exceeds the ${MAX_CELLS}-cell parsing limit.`);
    }
    sheets.push({
      name,
      index,
      hidden: Boolean(workbook.Workbook?.Sheets?.[index]?.Hidden),
      cells: [...cellsByAddress.values()].toSorted(compareCells),
      merges: (worksheet["!merges"] ?? [])
        .map((range) => XLSX.utils.encode_range(range))
        .toSorted(),
      columnWidths: readColumnWidths(worksheet),
      tables: objects.tables.toSorted((left, right) => left.name.localeCompare(right.name)),
      charts: objects.charts.toSorted((left, right) => left.id.localeCompare(right.id)),
    });
  }
  return { sheets };
}

function isCellAddress(value: string): boolean {
  return /^[A-Z]+[1-9][0-9]*$/i.test(value);
}

function normalizeCellValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizeCellStyle(
  cell: XLSX.CellObject | undefined,
  packageStyle: SpreadsheetCellStyle | undefined,
): SpreadsheetCellStyle | null {
  const record = cell as (XLSX.CellObject & { s?: unknown; z?: unknown }) | undefined;
  const styleRecord = asRecord(record?.s);
  const font = asRecord(styleRecord?.font);
  const fill = asRecord(styleRecord?.fill);
  const alignment = asRecord(styleRecord?.alignment);
  const combined: SpreadsheetCellStyle = {
    ...(packageStyle ?? {}),
    ...(font?.bold === true ? { bold: true } : {}),
    ...(font?.italic === true ? { italic: true } : {}),
    ...(typeof font?.sz === "number" ? { fontSize: font.sz } : {}),
    ...(typeof alignment?.horizontal === "string" ? { horizontalAlign: alignment.horizontal } : {}),
    ...(typeof record?.z === "string" ? { numberFormat: record.z } : {}),
    ...(typeof fill?.fgColor === "string" ? { fillColor: fill.fgColor } : {}),
  };
  return Object.keys(combined).length > 0 ? sortObject(combined) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sortObject(style: SpreadsheetCellStyle): SpreadsheetCellStyle {
  return Object.fromEntries(
    Object.entries(style).toSorted(([left], [right]) => left.localeCompare(right)),
  ) as SpreadsheetCellStyle;
}

function readColumnWidths(worksheet: XLSX.WorkSheet): XlsxColumnWidth[] {
  return (worksheet["!cols"] ?? []).flatMap((column, index) => {
    const entry = column as { wch?: unknown; wpx?: unknown } | undefined;
    if (!entry) return [];
    const widthChars =
      typeof entry.wch === "number" && Number.isFinite(entry.wch) ? entry.wch : null;
    const widthPixels =
      typeof entry.wpx === "number" && Number.isFinite(entry.wpx) ? entry.wpx : null;
    if (widthChars === null && widthPixels === null) return [];
    return [{ column: index, widthChars, widthPixels }];
  });
}

function compareCells(left: XlsxCell, right: XlsxCell): number {
  const leftCell = XLSX.utils.decode_cell(left.address);
  const rightCell = XLSX.utils.decode_cell(right.address);
  return leftCell.r - rightCell.r || leftCell.c - rightCell.c;
}
