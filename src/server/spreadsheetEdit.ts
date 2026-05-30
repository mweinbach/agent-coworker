import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";
import * as XLSX from "xlsx";

import type {
  SpreadsheetCellEditRequest,
  SpreadsheetCellEditResult,
} from "../shared/spreadsheetPreview";
import { resolveWorkspaceFilePath, validateXlsxZipSignature } from "./spreadsheetPreview";

/**
 * Apply a single-cell edit to a CSV or XLSX file and persist it, losslessly.
 *
 * CSV: a quote-aware parse → set → minimal re-quote round trip that preserves
 * BOM, line terminator, and trailing-newline state.
 *
 * XLSX: a surgical zip patch. Only the target worksheet XML part is rewritten;
 * every other entry (styles.xml, sharedStrings.xml, charts, pivot tables, other
 * sheets) is passed through untouched. The edited cell keeps its `s` style index
 * so formatting survives. SheetJS's community build cannot write styles, which
 * is exactly why we never round-trip the workbook through it here.
 */
export async function editSpreadsheetCell(
  req: SpreadsheetCellEditRequest,
): Promise<SpreadsheetCellEditResult> {
  let resolvedPath: string;
  try {
    resolvedPath = await resolveWorkspaceFilePath(req.cwd, req.filePath);
  } catch (error) {
    return {
      ok: false,
      error: { kind: "not_found", message: error instanceof Error ? error.message : String(error) },
    };
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  try {
    if (ext === ".csv") return await editCsvCell(resolvedPath, req);
    if (ext === ".xlsx") return await editXlsxCell(resolvedPath, req);
    return {
      ok: false,
      error: { kind: "unsupported_format", message: "Editing supports CSV and XLSX files." },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "write_error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

type CellAddress = { row: number; col: number };

function parseAddress(address: string): CellAddress | null {
  const trimmed = address.trim().toUpperCase();
  if (!/^[A-Z]+[1-9][0-9]*$/.test(trimmed)) return null;
  const decoded = XLSX.utils.decode_cell(trimmed);
  if (decoded.r < 0 || decoded.c < 0) return null;
  return { row: decoded.r, col: decoded.c };
}

async function writeFileAtomic(filePath: string, data: Buffer | string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

async function editCsvCell(
  filePath: string,
  req: SpreadsheetCellEditRequest,
): Promise<SpreadsheetCellEditResult> {
  const addr = parseAddress(req.address);
  if (!addr) {
    return {
      ok: false,
      error: { kind: "parse_error", message: `Invalid cell address: ${req.address}` },
    };
  }

  const raw = (await fs.readFile(filePath)).toString("utf8");
  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const text = hasBom ? raw.slice(1) : raw;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = /\r?\n$/.test(text);

  const rows = parseCsv(text);
  while (rows.length <= addr.row) rows.push([]);
  const row = rows[addr.row] as string[];
  while (row.length <= addr.col) row.push("");
  row[addr.col] = req.rawInput;

  let out = rows.map((cells) => cells.map(csvQuoteField).join(",")).join(eol);
  if (hasTrailingNewline) out += eol;
  if (hasBom) out = `﻿${out}`;

  await writeFileAtomic(filePath, out);
  return { ok: true };
}

/** Quote-aware CSV parse into a 2D array of decoded field values. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Flush a trailing record only when there is pending content (no phantom row
  // after a terminating newline).
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvQuoteField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// XLSX (surgical, lossless)
// ---------------------------------------------------------------------------

async function editXlsxCell(
  filePath: string,
  req: SpreadsheetCellEditRequest,
): Promise<SpreadsheetCellEditResult> {
  const addr = parseAddress(req.address);
  if (!addr) {
    return {
      ok: false,
      error: { kind: "parse_error", message: `Invalid cell address: ${req.address}` },
    };
  }

  const bytes = await fs.readFile(filePath);
  validateXlsxZipSignature(bytes);
  const zip = await JSZip.loadAsync(bytes);

  const partPath = await resolveWorksheetPart(zip, req.sheetName);
  if (!partPath) {
    return {
      ok: false,
      error: { kind: "not_found", message: `Sheet not found: ${req.sheetName ?? "(first sheet)"}` },
    };
  }
  const partFile = zip.file(partPath);
  if (!partFile) {
    return {
      ok: false,
      error: { kind: "parse_error", message: `Worksheet part missing: ${partPath}` },
    };
  }

  const sheetXml = await partFile.async("string");
  const ref = XLSX.utils.encode_cell({ r: addr.row, c: addr.col });
  const styleAttr = readCellStyleAttr(sheetXml, ref);
  const cellXml = encodeCellXml(ref, styleAttr, req.rawInput);
  const newSheetXml = applyCellEdit(sheetXml, addr, ref, cellXml);

  const validation = XMLValidator.validate(newSheetXml);
  if (validation !== true) {
    return {
      ok: false,
      error: {
        kind: "parse_error",
        message: `Edited worksheet XML is invalid: ${validation.err?.msg ?? "unknown error"}`,
      },
    };
  }

  zip.file(partPath, newSheetXml);
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await writeFileAtomic(filePath, out);
  return { ok: true };
}

/**
 * Resolve a sheet name to its worksheet zip part via the standard 3-hop lookup
 * (workbook.xml `name`→`r:id`, then workbook.xml.rels `r:id`→`Target`). Sheet
 * document position does NOT equal the sheetN.xml number, so this indirection
 * is required. Defaults to the first sheet when no name is given.
 */
async function resolveWorksheetPart(zip: JSZip, sheetName?: string): Promise<string | null> {
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  if (!workbookXml) return null;

  const sheets = [...workbookXml.matchAll(/<sheet\b[^>]*?\/?>/g)].map((m) => ({
    name: decodeXmlEntities(getXmlAttr(m[0], "name") ?? ""),
    rid: getXmlAttr(m[0], "r:id") ?? getXmlAttr(m[0], "id") ?? "",
  }));
  if (sheets.length === 0) return null;

  const target = sheetName ? sheets.find((s) => s.name === sheetName) : sheets[0];
  if (!target) return null;

  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!relsXml) return null;
  const rel = [...relsXml.matchAll(/<Relationship\b[^>]*?\/?>/g)]
    .map((m) => m[0])
    .find((tag) => getXmlAttr(tag, "Id") === target.rid);
  if (!rel) return null;

  const rawTarget = getXmlAttr(rel, "Target");
  if (!rawTarget) return null;
  return rawTarget.startsWith("/")
    ? normalizeZipPath(rawTarget.slice(1))
    : normalizeZipPath(`xl/${rawTarget}`);
}

function getXmlAttr(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*"([^"]*)"`));
  return match ? match[1] : undefined;
}

function normalizeZipPath(p: string): string {
  const out: string[] = [];
  for (const segment of p.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

/** Pull the existing `s="N"` style attribute off the target cell, if any. */
function readCellStyleAttr(sheetXml: string, ref: string): string {
  const match = sheetXml.match(new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*?>`));
  if (!match) {
    const selfClosing = sheetXml.match(new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*?/>`));
    if (!selfClosing) return "";
    const s = getXmlAttr(selfClosing[0], "s");
    return s !== undefined ? `s="${s}"` : "";
  }
  const s = getXmlAttr(match[0], "s");
  return s !== undefined ? `s="${s}"` : "";
}

function encodeCellXml(ref: string, styleAttr: string, rawInput: string): string {
  const s = styleAttr ? ` ${styleAttr}` : "";
  if (rawInput === "") {
    return `<c r="${ref}"${s}/>`;
  }
  if (rawInput.startsWith("=")) {
    return `<c r="${ref}"${s}><f>${escapeXmlText(rawInput.slice(1))}</f></c>`;
  }
  const trimmed = rawInput.trim();
  if (/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) {
    return `<c r="${ref}"${s}><v>${trimmed}</v></c>`;
  }
  const needsPreserve = /^\s|\s$|[\r\n]/.test(rawInput);
  const space = needsPreserve ? ' xml:space="preserve"' : "";
  return `<c r="${ref}"${s} t="inlineStr"><is><t${space}>${escapeXmlText(rawInput)}</t></is></c>`;
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Replace the target cell in the worksheet XML, creating the cell (and its row)
 * in ascending order when absent. Only the single `<c>` / `<row>` is touched.
 */
function applyCellEdit(xml: string, addr: CellAddress, ref: string, cellXml: string): string {
  const selfClose = new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*?/>`);
  if (selfClose.test(xml)) {
    return maybeExpandDimension(xml.replace(selfClose, cellXml), addr);
  }
  const withChildren = new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*?>[\\s\\S]*?</c>`);
  if (withChildren.test(xml)) {
    return maybeExpandDimension(xml.replace(withChildren, cellXml), addr);
  }
  return maybeExpandDimension(insertCell(xml, addr, ref, cellXml), addr);
}

function insertCell(xml: string, addr: CellAddress, _ref: string, cellXml: string): string {
  const rowNum = addr.row + 1;
  const rowOpen = new RegExp(`<row\\b[^>]*\\br="${rowNum}"[^>]*?>`).exec(xml);
  if (rowOpen) {
    const innerStart = rowOpen.index + rowOpen[0].length;
    const innerEnd = xml.indexOf("</row>", innerStart);
    if (innerEnd === -1) throw new Error(`Row ${rowNum} is not closed.`);
    const inner = xml.slice(innerStart, innerEnd);
    const insertAt = findCellInsertOffset(inner, addr.col);
    const newInner = inner.slice(0, insertAt) + cellXml + inner.slice(insertAt);
    return xml.slice(0, innerStart) + newInner + xml.slice(innerEnd);
  }

  const newRow = `<row r="${rowNum}">${cellXml}</row>`;
  const selfClosingSheetData = /<sheetData\s*\/>/;
  if (selfClosingSheetData.test(xml)) {
    return xml.replace(selfClosingSheetData, `<sheetData>${newRow}</sheetData>`);
  }
  const sheetDataOpen = /<sheetData\b[^>]*?>/.exec(xml);
  if (!sheetDataOpen) throw new Error("Worksheet has no <sheetData> element.");
  const innerStart = sheetDataOpen.index + sheetDataOpen[0].length;
  const innerEnd = xml.indexOf("</sheetData>", innerStart);
  if (innerEnd === -1) throw new Error("Worksheet <sheetData> is not closed.");
  const inner = xml.slice(innerStart, innerEnd);
  const insertAt = findRowInsertOffset(inner, rowNum);
  const newInner = inner.slice(0, insertAt) + newRow + inner.slice(insertAt);
  return xml.slice(0, innerStart) + newInner + xml.slice(innerEnd);
}

/** Offset within a row's inner XML to insert a new cell so columns stay sorted. */
function findCellInsertOffset(rowInner: string, col: number): number {
  const cellRe = /<c\b[^>]*?\br="([A-Z]+\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
  let match = cellRe.exec(rowInner);
  while (match) {
    const matchedCol = XLSX.utils.decode_cell(match[1] as string).c;
    if (matchedCol > col) return match.index;
    match = cellRe.exec(rowInner);
  }
  return rowInner.length;
}

/** Offset within sheetData's inner XML to insert a new row so rows stay sorted. */
function findRowInsertOffset(sheetDataInner: string, rowNum: number): number {
  const rowRe = /<row\b[^>]*?\br="(\d+)"[^>]*?>/g;
  let match = rowRe.exec(sheetDataInner);
  while (match) {
    if (Number.parseInt(match[1] as string, 10) > rowNum) return match.index;
    match = rowRe.exec(sheetDataInner);
  }
  return sheetDataInner.length;
}

/** Best-effort: widen <dimension> to include the edited cell (Excel recomputes). */
function maybeExpandDimension(xml: string, addr: CellAddress): string {
  const dimRe = /<dimension\b[^>]*\bref="([^"]+)"[^>]*\/>/;
  const match = dimRe.exec(xml);
  if (!match) return xml;
  try {
    const range = XLSX.utils.decode_range(match[1] as string);
    let changed = false;
    if (addr.row < range.s.r) {
      range.s.r = addr.row;
      changed = true;
    }
    if (addr.col < range.s.c) {
      range.s.c = addr.col;
      changed = true;
    }
    if (addr.row > range.e.r) {
      range.e.r = addr.row;
      changed = true;
    }
    if (addr.col > range.e.c) {
      range.e.c = addr.col;
      changed = true;
    }
    if (!changed) return xml;
    return xml.replace(dimRe, `<dimension ref="${XLSX.utils.encode_range(range)}"/>`);
  } catch {
    return xml;
  }
}
