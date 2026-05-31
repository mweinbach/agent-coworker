import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";
import * as XLSX from "xlsx";

import type {
  SpreadsheetBatchPatchOperation,
  SpreadsheetBatchPatchRequest,
  SpreadsheetBatchPatchResult,
  SpreadsheetCellEditFailureKind,
  SpreadsheetCellEditRequest,
  SpreadsheetCellEditResult,
  SpreadsheetCellStylePatch,
  SpreadsheetRangeFormatRequest,
  SpreadsheetRangeFormatResult,
} from "../shared/spreadsheetPreview";
import { resolveWorkspaceFilePath, validateXlsxZipSignature } from "./spreadsheetPreview";

const MAX_BATCH_PATCH_OPERATIONS = 2_000;

type EditFailure = { kind: SpreadsheetCellEditFailureKind; message: string };

/**
 * Outcome of applying an ordered list of operations to one file. `index` marks
 * which operation failed so the batch entry point can attribute the error, or is
 * `null` when the failure isn't tied to a specific operation (file read/write,
 * post-batch validation, or an unsupported file type).
 */
type OpsOutcome = { ok: true } | { ok: false; index: number | null; error: EditFailure };

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
  const target = await resolveEditTarget(req.cwd, req.filePath);
  if (!target.ok) return target;
  const outcome = await executeOps(target.resolvedPath, target.ext, [
    {
      type: "cell",
      ...(req.sheetName ? { sheetName: req.sheetName } : {}),
      address: req.address,
      rawInput: req.rawInput,
    },
  ]);
  return outcome.ok ? { ok: true } : { ok: false, error: outcome.error };
}

export async function formatSpreadsheetRange(
  req: SpreadsheetRangeFormatRequest,
): Promise<SpreadsheetRangeFormatResult> {
  const target = await resolveEditTarget(req.cwd, req.filePath);
  if (!target.ok) return target;
  const outcome = await executeOps(target.resolvedPath, target.ext, [
    {
      type: "format",
      ...(req.sheetName ? { sheetName: req.sheetName } : {}),
      range: req.range,
      style: req.style,
    },
  ]);
  return outcome.ok ? { ok: true } : { ok: false, error: outcome.error };
}

/**
 * Apply an ordered batch of cell/format operations as a single atomic
 * read-modify-write: the file is read and (for XLSX) unzipped exactly once, all
 * operations are applied in memory, and the result is written exactly once. A
 * mid-batch failure aborts before any bytes are persisted, so partial batches
 * never land on disk.
 */
export async function patchSpreadsheetBatch(
  req: SpreadsheetBatchPatchRequest,
): Promise<SpreadsheetBatchPatchResult> {
  if (req.operations.length > MAX_BATCH_PATCH_OPERATIONS) {
    return {
      ok: false,
      error: {
        kind: "parse_error",
        message: `Spreadsheet patch batches are limited to ${MAX_BATCH_PATCH_OPERATIONS} operations.`,
      },
    };
  }
  // A no-op batch must not touch disk (re-zipping or re-quoting would change the
  // file's bytes and fingerprint with no actual edit).
  if (req.operations.length === 0) return { ok: true };

  const target = await resolveEditTarget(req.cwd, req.filePath);
  if (!target.ok) return target;
  const outcome = await executeOps(target.resolvedPath, target.ext, req.operations);
  if (outcome.ok) return { ok: true };
  // Attribute the failure to a specific operation only when one is known.
  const message =
    outcome.index === null
      ? outcome.error.message
      : `Operation ${outcome.index + 1} failed: ${outcome.error.message}`;
  return { ok: false, error: { kind: outcome.error.kind, message } };
}

async function resolveEditTarget(
  cwd: string,
  filePath: string,
): Promise<{ ok: true; resolvedPath: string; ext: string } | { ok: false; error: EditFailure }> {
  try {
    const resolvedPath = await resolveWorkspaceFilePath(cwd, filePath);
    return { ok: true, resolvedPath, ext: path.extname(resolvedPath).toLowerCase() };
  } catch (error) {
    return {
      ok: false,
      error: { kind: "not_found", message: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * Serialize all read-modify-write cycles against a given resolved path so two
 * concurrent edits to the same workbook can never interleave and clobber each
 * other. Failures don't poison the lock; the next waiter still runs.
 */
const fileWriteChains = new Map<string, Promise<void>>();

function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = fileWriteChains.get(filePath) ?? Promise.resolve();
  const result = previous.then(fn, fn);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  fileWriteChains.set(filePath, settled);
  void settled.then(() => {
    if (fileWriteChains.get(filePath) === settled) fileWriteChains.delete(filePath);
  });
  return result;
}

/** Acquire the per-file lock, dispatch by extension, and map throws to write_error. */
function executeOps(
  resolvedPath: string,
  ext: string,
  operations: SpreadsheetBatchPatchOperation[],
): Promise<OpsOutcome> {
  return withFileLock(resolvedPath, async () => {
    try {
      if (ext === ".csv") return await runCsvOps(resolvedPath, operations);
      if (ext === ".xlsx") return await runXlsxOps(resolvedPath, operations);
      const message =
        operations[0]?.type === "format"
          ? "Formatting supports XLSX files."
          : "Editing supports CSV and XLSX files.";
      return { ok: false, index: null, error: { kind: "unsupported_format", message } };
    } catch (error) {
      // A throw here is from reading/loading or writing the file, not a single op.
      return {
        ok: false,
        index: null,
        error: {
          kind: "write_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
}

type CellAddress = { row: number; col: number };
type CellRange = { start: CellAddress; end: CellAddress };
type XmlRecord = Record<string, unknown>;

function parseAddress(address: string): CellAddress | null {
  const trimmed = address.trim().toUpperCase();
  if (!/^[A-Z]+[1-9][0-9]*$/.test(trimmed)) return null;
  const decoded = XLSX.utils.decode_cell(trimmed);
  if (decoded.r < 0 || decoded.c < 0) return null;
  return { row: decoded.r, col: decoded.c };
}

function parseRange(rangeRef: string): CellRange | null {
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

async function runCsvOps(
  filePath: string,
  operations: SpreadsheetBatchPatchOperation[],
): Promise<OpsOutcome> {
  const raw = (await fs.readFile(filePath)).toString("utf8");
  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const text = hasBom ? raw.slice(1) : raw;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = /\r?\n$/.test(text);

  const rows = parseCsv(text);
  for (const [index, op] of operations.entries()) {
    if (op.type === "format") {
      return {
        ok: false,
        index,
        error: { kind: "unsupported_format", message: "Formatting supports XLSX files." },
      };
    }
    const addr = parseAddress(op.address);
    if (!addr) {
      return {
        ok: false,
        index,
        error: { kind: "parse_error", message: `Invalid cell address: ${op.address}` },
      };
    }
    while (rows.length <= addr.row) rows.push([]);
    const row = rows[addr.row] as string[];
    while (row.length <= addr.col) row.push("");
    row[addr.col] = op.rawInput;
  }

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

/**
 * In-memory editing session over a single workbook: the zip is loaded once and
 * worksheet XML parts plus the stylesheet are read, mutated, and cached here so
 * a whole batch shares one read-modify-write cycle. Nothing touches disk until
 * {@link flushXlsxSession} validates and {@link writeXlsxSession} persists.
 */
type XlsxSession = {
  zip: JSZip;
  sheetXmlByPart: Map<string, string>;
  partBySheet: Map<string, string | null>;
  dirtyParts: Set<string>;
  styles: ReturnType<typeof parseStylesheet> | null;
  stylesDirty: boolean;
};

async function runXlsxOps(
  filePath: string,
  operations: SpreadsheetBatchPatchOperation[],
): Promise<OpsOutcome> {
  const bytes = await fs.readFile(filePath);
  validateXlsxZipSignature(bytes);
  const session: XlsxSession = {
    zip: await JSZip.loadAsync(bytes),
    sheetXmlByPart: new Map(),
    partBySheet: new Map(),
    dirtyParts: new Set(),
    styles: null,
    stylesDirty: false,
  };

  for (const [index, op] of operations.entries()) {
    let failure: EditFailure | null;
    try {
      failure =
        op.type === "cell"
          ? await applyXlsxCellOp(session, op)
          : await applyXlsxFormatOp(session, op);
    } catch (error) {
      // e.g. an invalid color reaching normalizeColor — attribute it to this op.
      return {
        ok: false,
        index,
        error: {
          kind: "write_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (failure) return { ok: false, index, error: failure };
  }

  const flushed = flushXlsxSession(session);
  if (!flushed.ok) return { ok: false, index: null, error: flushed.error };

  // Skip the rewrite entirely when no operation actually mutated the workbook.
  if (session.dirtyParts.size > 0 || session.stylesDirty) {
    await writeXlsxSession(session, filePath);
  }
  return { ok: true };
}

async function sessionWorksheetPart(
  session: XlsxSession,
  sheetName?: string,
): Promise<string | null> {
  const key = sheetName ?? "";
  if (!session.partBySheet.has(key)) {
    session.partBySheet.set(key, await resolveWorksheetPart(session.zip, sheetName));
  }
  return session.partBySheet.get(key) ?? null;
}

async function sessionSheetXml(session: XlsxSession, partPath: string): Promise<string | null> {
  const cached = session.sheetXmlByPart.get(partPath);
  if (cached !== undefined) return cached;
  const file = session.zip.file(partPath);
  if (!file) return null;
  const xml = await file.async("string");
  session.sheetXmlByPart.set(partPath, xml);
  return xml;
}

async function sessionStyles(session: XlsxSession): Promise<ReturnType<typeof parseStylesheet>> {
  if (!session.styles) {
    session.styles = parseStylesheet(await ensureStylesXml(session.zip));
  }
  return session.styles;
}

async function applyXlsxCellOp(
  session: XlsxSession,
  op: { sheetName?: string; address: string; rawInput: string },
): Promise<EditFailure | null> {
  const addr = parseAddress(op.address);
  if (!addr) return { kind: "parse_error", message: `Invalid cell address: ${op.address}` };

  const partPath = await sessionWorksheetPart(session, op.sheetName);
  if (!partPath) {
    return { kind: "not_found", message: `Sheet not found: ${op.sheetName ?? "(first sheet)"}` };
  }
  const sheetXml = await sessionSheetXml(session, partPath);
  if (sheetXml === null) {
    return { kind: "parse_error", message: `Worksheet part missing: ${partPath}` };
  }

  const ref = XLSX.utils.encode_cell({ r: addr.row, c: addr.col });
  const styleAttr = readCellStyleAttr(sheetXml, ref);
  const cellXml = encodeCellXml(ref, styleAttr, op.rawInput);
  session.sheetXmlByPart.set(partPath, applyCellEdit(sheetXml, addr, ref, cellXml));
  session.dirtyParts.add(partPath);
  return null;
}

async function applyXlsxFormatOp(
  session: XlsxSession,
  op: { sheetName?: string; range: string; style: SpreadsheetCellStylePatch },
): Promise<EditFailure | null> {
  const range = parseRange(op.range);
  if (!range) return { kind: "parse_error", message: `Invalid cell range: ${op.range}` };

  const cellCount = (range.end.row - range.start.row + 1) * (range.end.col - range.start.col + 1);
  if (cellCount > 50_000) {
    return {
      kind: "parse_error",
      message: "Formatting ranges are limited to 50,000 cells per request.",
    };
  }

  const partPath = await sessionWorksheetPart(session, op.sheetName);
  if (!partPath) {
    return { kind: "not_found", message: `Sheet not found: ${op.sheetName ?? "(first sheet)"}` };
  }
  let sheetXml = await sessionSheetXml(session, partPath);
  if (sheetXml === null) {
    return { kind: "parse_error", message: `Worksheet part missing: ${partPath}` };
  }

  const styles = await sessionStyles(session);
  const styleCache = new Map<string, number>();
  for (let row = range.start.row; row <= range.end.row; row += 1) {
    for (let col = range.start.col; col <= range.end.col; col += 1) {
      const ref = XLSX.utils.encode_cell({ r: row, c: col });
      const currentStyle = Number.parseInt(readCellStyleIndex(sheetXml, ref) ?? "0", 10);
      const baseStyle = Number.isFinite(currentStyle) && currentStyle >= 0 ? currentStyle : 0;
      const cacheKey = `${baseStyle}:${JSON.stringify(op.style)}`;
      let nextStyle = styleCache.get(cacheKey);
      if (nextStyle === undefined) {
        nextStyle = styles.applyPatch(baseStyle, op.style);
        styleCache.set(cacheKey, nextStyle);
      }
      sheetXml = applyCellStyle(sheetXml, { row, col }, ref, nextStyle);
    }
  }

  session.sheetXmlByPart.set(partPath, sheetXml);
  session.dirtyParts.add(partPath);
  session.stylesDirty = true;
  return null;
}

/** Validate every mutated part once and stage it back into the in-memory zip. */
function flushXlsxSession(session: XlsxSession): { ok: true } | { ok: false; error: EditFailure } {
  for (const partPath of session.dirtyParts) {
    const xml = session.sheetXmlByPart.get(partPath);
    if (xml === undefined) continue;
    const validation = XMLValidator.validate(xml);
    if (validation !== true) {
      return {
        ok: false,
        error: {
          kind: "parse_error",
          message: `Edited worksheet XML is invalid: ${validation.err?.msg ?? "unknown error"}`,
        },
      };
    }
    session.zip.file(partPath, xml);
  }

  if (session.stylesDirty && session.styles) {
    const newStylesXml = session.styles.toXml();
    const validation = XMLValidator.validate(newStylesXml);
    if (validation !== true) {
      return {
        ok: false,
        error: {
          kind: "parse_error",
          message: `Formatted styles XML is invalid: ${validation.err?.msg ?? "unknown error"}`,
        },
      };
    }
    session.zip.file("xl/styles.xml", newStylesXml);
  }

  return { ok: true };
}

async function writeXlsxSession(session: XlsxSession, filePath: string): Promise<void> {
  const out = await session.zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await writeFileAtomic(filePath, out);
}

const OOXML_STYLE_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
});

const OOXML_STYLE_BUILDER = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  suppressEmptyNode: true,
  format: false,
});

async function ensureStylesXml(zip: JSZip): Promise<string> {
  const existing = await zip.file("xl/styles.xml")?.async("string");
  if (existing) return existing;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

function parseStylesheet(xml: string): {
  applyPatch: (styleIndex: number, patch: SpreadsheetCellStylePatch) => number;
  toXml: () => string;
} {
  const root = asRecord(OOXML_STYLE_PARSER.parse(xml)) ?? {};
  delete root["?xml"];
  const styleSheet = ensureRecord(root, "styleSheet");
  const fontsNode = ensureRecord(styleSheet, "fonts");
  const fillsNode = ensureRecord(styleSheet, "fills");
  const bordersNode = ensureRecord(styleSheet, "borders");
  const cellStyleXfsNode = ensureRecord(styleSheet, "cellStyleXfs");
  const cellXfsNode = ensureRecord(styleSheet, "cellXfs");

  const fonts = ensureNodeArray(fontsNode, "font", [defaultFont()]);
  const fills = ensureNodeArray(fillsNode, "fill", defaultFills());
  ensureNodeArray(bordersNode, "border", [defaultBorder()]);
  ensureNodeArray(cellStyleXfsNode, "xf", [defaultXf()]);
  const cellXfs = ensureNodeArray(cellXfsNode, "xf", [defaultXf()]);

  const syncCounts = () => {
    fontsNode.count = String(fonts.length);
    fillsNode.count = String(fills.length);
    bordersNode.count = String(ensureNodeArray(bordersNode, "border", [defaultBorder()]).length);
    cellStyleXfsNode.count = String(
      ensureNodeArray(cellStyleXfsNode, "xf", [defaultXf()]).length,
    );
    cellXfsNode.count = String(cellXfs.length);
  };

  const findOrAdd = (items: XmlRecord[], node: XmlRecord): number => {
    const key = stableStringify(node);
    const found = items.findIndex((item) => stableStringify(item) === key);
    if (found >= 0) return found;
    items.push(node);
    return items.length - 1;
  };

  return {
    applyPatch(styleIndex: number, patch: SpreadsheetCellStylePatch): number {
      const baseXf = cloneRecord(cellXfs[styleIndex] ?? cellXfs[0] ?? defaultXf());
      const fontId = readNonnegativeInteger(baseXf.fontId) ?? 0;
      const fillId = readNonnegativeInteger(baseXf.fillId) ?? 0;
      const font = cloneRecord(fonts[fontId] ?? fonts[0] ?? defaultFont());
      let fill = cloneRecord(fills[fillId] ?? fills[0] ?? defaultFill());
      let fontChanged = false;
      let fillChanged = false;
      let alignmentChanged = false;

      if (Object.hasOwn(patch, "bold")) {
        fontChanged = true;
        if (patch.bold) font.b = {};
        else delete font.b;
      }
      if (Object.hasOwn(patch, "italic")) {
        fontChanged = true;
        if (patch.italic) font.i = {};
        else delete font.i;
      }
      if (Object.hasOwn(patch, "fontSize")) {
        fontChanged = true;
        if (patch.fontSize === null || patch.fontSize === undefined) delete font.sz;
        else font.sz = { val: formatStyleNumber(patch.fontSize) };
      }
      if (Object.hasOwn(patch, "textColor")) {
        fontChanged = true;
        if (patch.textColor === null) delete font.color;
        else font.color = { rgb: normalizeColor(patch.textColor) };
      }
      if (Object.hasOwn(patch, "fillColor")) {
        fillChanged = true;
        fill =
          patch.fillColor === null
            ? cloneRecord(defaultFill())
            : {
                patternFill: {
                  patternType: "solid",
                  fgColor: { rgb: normalizeColor(patch.fillColor) },
                  bgColor: { indexed: "64" },
                },
              };
      }
      if (Object.hasOwn(patch, "horizontalAlign")) {
        alignmentChanged = true;
        if (patch.horizontalAlign === null) {
          const alignment = asRecord(baseXf.alignment);
          if (alignment) {
            delete alignment.horizontal;
            if (Object.keys(alignment).length === 0) delete baseXf.alignment;
          }
          delete baseXf.applyAlignment;
        } else {
          baseXf.alignment = {
            ...(asRecord(baseXf.alignment) ?? {}),
            horizontal: patch.horizontalAlign,
          };
          baseXf.applyAlignment = "1";
        }
      }

      if (fontChanged) {
        baseXf.fontId = String(findOrAdd(fonts, font));
        baseXf.applyFont = "1";
      }
      if (fillChanged) {
        baseXf.fillId = String(findOrAdd(fills, fill));
        baseXf.applyFill = "1";
      }
      if (alignmentChanged && baseXf.alignment) {
        baseXf.applyAlignment = "1";
      }

      const nextStyleIndex = findOrAdd(cellXfs, baseXf);
      syncCounts();
      return nextStyleIndex;
    },
    toXml(): string {
      syncCounts();
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${OOXML_STYLE_BUILDER.build(
        root,
      )}`;
    },
  };
}

function readCellStyleIndex(sheetXml: string, ref: string): string | undefined {
  const match =
    sheetXml.match(new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*?>`)) ??
    sheetXml.match(new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*?/>`));
  return match ? getXmlAttr(match[0], "s") : undefined;
}

function applyCellStyle(xml: string, addr: CellAddress, ref: string, styleIndex: number): string {
  const selfClose = new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*?/>`);
  if (selfClose.test(xml)) {
    return maybeExpandDimension(xml.replace(selfClose, (cellXml) => setCellStyle(cellXml, styleIndex)), addr);
  }
  const withChildren = new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*?>[\\s\\S]*?</c>`);
  if (withChildren.test(xml)) {
    return maybeExpandDimension(
      xml.replace(withChildren, (cellXml) => setCellStyle(cellXml, styleIndex)),
      addr,
    );
  }
  return maybeExpandDimension(insertCell(xml, addr, ref, `<c r="${ref}" s="${styleIndex}"/>`), addr);
}

function setCellStyle(cellXml: string, styleIndex: number): string {
  const openTag = /^<c\b[^>]*?>/.exec(cellXml)?.[0];
  if (!openTag) return cellXml;
  const withoutStyle = openTag.replace(/\s+s="[^"]*"/, "");
  const styledTag = withoutStyle.endsWith("/>")
    ? `${withoutStyle.slice(0, -2)} s="${styleIndex}"/>`
    : `${withoutStyle.slice(0, -1)} s="${styleIndex}">`;
  return styledTag + cellXml.slice(openTag.length);
}

function ensureRecord(parent: XmlRecord, key: string): XmlRecord {
  const existing = asRecord(parent[key]);
  if (existing) return existing;
  const created: XmlRecord = {};
  parent[key] = created;
  return created;
}

function ensureNodeArray(parent: XmlRecord, key: string, fallback: XmlRecord[]): XmlRecord[] {
  const value = parent[key];
  let nodes: XmlRecord[];
  if (Array.isArray(value)) {
    nodes = value.map(asRecord).filter((node): node is XmlRecord => node !== null);
  } else {
    const node = asRecord(value);
    nodes = node ? [node] : fallback.map(cloneRecord);
  }
  parent[key] = nodes;
  return nodes;
}

function asRecord(value: unknown): XmlRecord | null {
  return typeof value === "object" && value !== null ? (value as XmlRecord) : null;
}

function cloneRecord(value: XmlRecord): XmlRecord {
  return JSON.parse(JSON.stringify(value)) as XmlRecord;
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

function readNonnegativeInteger(value: unknown): number | null {
  const raw = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (!/^\d+$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}

function normalizeColor(value: string | null | undefined): string {
  const raw = (value ?? "").trim().replace(/^#/, "").toUpperCase();
  if (/^[0-9A-F]{6}$/.test(raw)) return `FF${raw}`;
  if (/^[0-9A-F]{8}$/.test(raw)) return raw;
  throw new Error(`Invalid spreadsheet color: ${value}`);
}

function formatStyleNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function defaultFont(): XmlRecord {
  return { sz: { val: "11" }, name: { val: "Calibri" } };
}

function defaultFills(): XmlRecord[] {
  return [defaultFill(), { patternFill: { patternType: "gray125" } }];
}

function defaultFill(): XmlRecord {
  return { patternFill: { patternType: "none" } };
}

function defaultBorder(): XmlRecord {
  return { left: {}, right: {}, top: {}, bottom: {}, diagonal: {} };
}

function defaultXf(): XmlRecord {
  return { numFmtId: "0", fontId: "0", fillId: "0", borderId: "0", xfId: "0" };
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
