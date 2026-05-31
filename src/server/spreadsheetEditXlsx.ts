import fs from "node:fs/promises";
import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import type {
  SpreadsheetBatchPatchOperation,
  SpreadsheetCellStylePatch,
} from "../shared/spreadsheetPreview";
import { type CellAddress, parseAddress, parseRange } from "./spreadsheetA1";
import type { EditFailure, OpsOutcome } from "./spreadsheetEditTypes";
import { asRecord, resolveWorksheetPart, stringValue, type XmlRecord } from "./spreadsheetOoxml";
import { validateXlsxZipSignature } from "./spreadsheetPreview";

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
  workbookDirty: boolean;
};

export async function runXlsxOps(
  filePath: string,
  operations: SpreadsheetBatchPatchOperation[],
  writeFileAtomic: (filePath: string, data: Buffer | string) => Promise<void>,
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
    workbookDirty: false,
  };

  for (const [index, op] of operations.entries()) {
    let failure: EditFailure | null;
    try {
      if (op.type === "cell") {
        failure = await applyXlsxCellOp(session, op);
      } else if (op.type === "format") {
        failure = await applyXlsxFormatOp(session, op);
      } else if (op.type === "merge") {
        failure = await applyXlsxMergeOp(session, op);
      } else {
        failure = await applyXlsxColumnWidthOp(session, op);
      }
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

  if (operations.some((op) => op.type === "cell")) {
    await invalidateFormulaCaches(session);
  }

  const flushed = await flushXlsxSession(session);
  if (!flushed.ok) return { ok: false, index: null, error: flushed.error };

  // Skip the rewrite entirely when no operation actually mutated the workbook.
  if (session.dirtyParts.size > 0 || session.stylesDirty || session.workbookDirty) {
    await writeXlsxSession(session, filePath, writeFileAtomic);
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

async function invalidateFormulaCaches(session: XlsxSession): Promise<void> {
  let foundFormulaCell = false;
  for (const partPath of Object.keys(session.zip.files)) {
    const file = session.zip.files[partPath];
    if (file?.dir || !/^xl\/worksheets\/[^/]+\.xml$/.test(partPath)) continue;
    const sheetXml = await sessionSheetXml(session, partPath);
    if (sheetXml === null) continue;
    const { xml: updated, foundFormula } = clearFormulaCachedValues(sheetXml);
    foundFormulaCell ||= foundFormula;
    if (updated === sheetXml) continue;
    session.sheetXmlByPart.set(partPath, updated);
    session.dirtyParts.add(partPath);
  }

  const hadCalcChain = Boolean(session.zip.file("xl/calcChain.xml"));
  if (hadCalcChain) {
    session.zip.remove("xl/calcChain.xml");
    session.workbookDirty = true;
  }
  if (!foundFormulaCell && !hadCalcChain) return;
  session.workbookDirty =
    (await updateZipTextPart(session.zip, "[Content_Types].xml", removeCalcChainContentType)) ||
    session.workbookDirty;
  session.workbookDirty =
    (await updateZipTextPart(
      session.zip,
      "xl/_rels/workbook.xml.rels",
      removeCalcChainRelationship,
    )) || session.workbookDirty;
  session.workbookDirty =
    (await updateZipTextPart(session.zip, "xl/workbook.xml", markWorkbookCalcPr)) ||
    session.workbookDirty;
}

function clearFormulaCachedValues(xml: string): { xml: string; foundFormula: boolean } {
  let foundFormula = false;
  const nextXml = xml.replace(/<c\b[^>]*>[\s\S]*?<\/c>/g, (cellXml) => {
    if (!/<f\b/.test(cellXml)) return cellXml;
    foundFormula = true;
    return cellXml.replace(/<v>[\s\S]*?<\/v>/g, "");
  });
  return { xml: nextXml, foundFormula };
}

async function updateZipTextPart(
  zip: JSZip,
  partPath: string,
  update: (xml: string) => string,
): Promise<boolean> {
  const file = zip.file(partPath);
  if (!file) return false;
  const xml = await file.async("string");
  const nextXml = update(xml);
  if (nextXml === xml) return false;
  zip.file(partPath, nextXml);
  return true;
}

function removeCalcChainContentType(xml: string): string {
  return xml.replace(
    /<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*(?:\/>|>[\s\S]*?<\/Override>)/g,
    "",
  );
}

function removeCalcChainRelationship(xml: string): string {
  return xml.replace(
    /<Relationship\b(?=[^>]*(?:Type="[^"]*\/calcChain"|Target="calcChain\.xml"))[^>]*\/>/g,
    "",
  );
}

function markWorkbookCalcPr(xml: string): string {
  const calcPr = '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>';
  if (/<calcPr\b[^>]*\/>/.test(xml)) {
    return xml.replace(/<calcPr\b[^>]*\/>/, calcPr);
  }
  if (/<calcPr\b[^>]*>[\s\S]*?<\/calcPr>/.test(xml)) {
    return xml.replace(/<calcPr\b[^>]*>[\s\S]*?<\/calcPr>/, calcPr);
  }
  return xml.replace("</workbook>", `${calcPr}</workbook>`);
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

async function applyXlsxMergeOp(
  session: XlsxSession,
  op: { sheetName?: string; range: string; merged: boolean },
): Promise<EditFailure | null> {
  const range = parseRange(op.range);
  if (!range) return { kind: "parse_error", message: `Invalid cell range: ${op.range}` };

  const partPath = await sessionWorksheetPart(session, op.sheetName);
  if (!partPath) {
    return { kind: "not_found", message: `Sheet not found: ${op.sheetName ?? "(first sheet)"}` };
  }
  const sheetXml = await sessionSheetXml(session, partPath);
  if (sheetXml === null) {
    return { kind: "parse_error", message: `Worksheet part missing: ${partPath}` };
  }

  session.sheetXmlByPart.set(partPath, applyWorksheetMerge(sheetXml, range, op.merged));
  session.dirtyParts.add(partPath);
  return null;
}

async function applyXlsxColumnWidthOp(
  session: XlsxSession,
  op: { sheetName?: string; col: number; widthPx: number | null },
): Promise<EditFailure | null> {
  if (op.widthPx !== null && (!Number.isFinite(op.widthPx) || op.widthPx <= 0)) {
    return { kind: "parse_error", message: `Invalid column width: ${op.widthPx}` };
  }

  const partPath = await sessionWorksheetPart(session, op.sheetName);
  if (!partPath) {
    return { kind: "not_found", message: `Sheet not found: ${op.sheetName ?? "(first sheet)"}` };
  }
  const sheetXml = await sessionSheetXml(session, partPath);
  if (sheetXml === null) {
    return { kind: "parse_error", message: `Worksheet part missing: ${partPath}` };
  }

  session.sheetXmlByPart.set(partPath, applyWorksheetColumnWidth(sheetXml, op.col, op.widthPx));
  session.dirtyParts.add(partPath);
  return null;
}

/** Validate every mutated part once and stage it back into the in-memory zip. */
async function flushXlsxSession(
  session: XlsxSession,
): Promise<{ ok: true } | { ok: false; error: EditFailure }> {
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
    session.workbookDirty = (await registerStylesPart(session.zip)) || session.workbookDirty;
    session.zip.file("xl/styles.xml", newStylesXml);
  }

  return { ok: true };
}

async function writeXlsxSession(
  session: XlsxSession,
  filePath: string,
  writeFileAtomic: (filePath: string, data: Buffer | string) => Promise<void>,
): Promise<void> {
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

const OOXML_SPREADSHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const OOXML_RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OOXML_STYLES_RELATIONSHIP_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles";
const OOXML_STYLES_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml";

async function ensureStylesXml(zip: JSZip): Promise<string> {
  const existing = await zip.file("xl/styles.xml")?.async("string");
  if (existing) return existing;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${OOXML_SPREADSHEET_NS}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

async function registerStylesPart(zip: JSZip): Promise<boolean> {
  const contentTypesChanged = await updateZipTextPart(
    zip,
    "[Content_Types].xml",
    ensureStylesContentType,
  );
  const relationshipChanged = await updateZipTextPart(
    zip,
    "xl/_rels/workbook.xml.rels",
    ensureStylesRelationship,
  );
  return contentTypesChanged || relationshipChanged;
}

function ensureStylesContentType(xml: string): string {
  if (/<Override\b[^>]*PartName="\/xl\/styles\.xml"[^>]*\/?>/.test(xml)) return xml;
  return xml.replace(
    "</Types>",
    `<Override PartName="/xl/styles.xml" ContentType="${OOXML_STYLES_CONTENT_TYPE}"/></Types>`,
  );
}

function ensureStylesRelationship(xml: string): string {
  if (
    xml.includes(`Type="${OOXML_STYLES_RELATIONSHIP_TYPE}"`) ||
    /<Relationship\b(?=[^>]*Target="styles\.xml")/.test(xml)
  ) {
    return xml;
  }
  const ids = [...xml.matchAll(/\bId="rId(\d+)"/g)]
    .map((match) => Number.parseInt(match[1] ?? "", 10))
    .filter((id) => Number.isFinite(id));
  const nextId = `rId${Math.max(0, ...ids) + 1}`;
  const relationship = `<Relationship Id="${nextId}" Type="${OOXML_STYLES_RELATIONSHIP_TYPE}" Target="styles.xml"/>`;
  if (xml.includes("</Relationships>")) {
    return xml.replace("</Relationships>", `${relationship}</Relationships>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${OOXML_RELATIONSHIPS_NS}">${relationship}</Relationships>`;
}

function parseStylesheet(xml: string): {
  applyPatch: (styleIndex: number, patch: SpreadsheetCellStylePatch) => number;
  toXml: () => string;
} {
  const root = asRecord(OOXML_STYLE_PARSER.parse(xml)) ?? {};
  delete root["?xml"];
  const styleSheet = ensureRecord(root, "styleSheet");
  styleSheet.xmlns ??= OOXML_SPREADSHEET_NS;
  const numFmtsNode = ensureRecord(styleSheet, "numFmts");
  const fontsNode = ensureRecord(styleSheet, "fonts");
  const fillsNode = ensureRecord(styleSheet, "fills");
  const bordersNode = ensureRecord(styleSheet, "borders");
  const cellStyleXfsNode = ensureRecord(styleSheet, "cellStyleXfs");
  const cellXfsNode = ensureRecord(styleSheet, "cellXfs");

  const numFmts = ensureNodeArray(numFmtsNode, "numFmt", []);
  const fonts = ensureNodeArray(fontsNode, "font", [defaultFont()]);
  const fills = ensureNodeArray(fillsNode, "fill", defaultFills());
  ensureNodeArray(bordersNode, "border", [defaultBorder()]);
  ensureNodeArray(cellStyleXfsNode, "xf", [defaultXf()]);
  const cellXfs = ensureNodeArray(cellXfsNode, "xf", [defaultXf()]);

  const syncCounts = () => {
    numFmtsNode.count = String(numFmts.length);
    fontsNode.count = String(fonts.length);
    fillsNode.count = String(fills.length);
    bordersNode.count = String(ensureNodeArray(bordersNode, "border", [defaultBorder()]).length);
    cellStyleXfsNode.count = String(ensureNodeArray(cellStyleXfsNode, "xf", [defaultXf()]).length);
    cellXfsNode.count = String(cellXfs.length);
  };

  const findOrAdd = (items: XmlRecord[], node: XmlRecord): number => {
    const key = stableStringify(node);
    const found = items.findIndex((item) => stableStringify(item) === key);
    if (found >= 0) return found;
    items.push(node);
    return items.length - 1;
  };

  const findOrAddNumberFormat = (pattern: string): number => {
    for (const numberFormat of numFmts) {
      const id = readNonnegativeInteger(numberFormat.numFmtId);
      if (id !== null && stringValue(numberFormat.formatCode) === pattern) return id;
    }
    const existingIds = numFmts
      .map((numberFormat) => readNonnegativeInteger(numberFormat.numFmtId))
      .filter((id): id is number => id !== null);
    const id = Math.max(164, ...existingIds.map((existingId) => existingId + 1));
    numFmts.push({ numFmtId: String(id), formatCode: pattern });
    return id;
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
      if (Object.hasOwn(patch, "numberFormat")) {
        if (patch.numberFormat === null || patch.numberFormat === undefined) {
          baseXf.numFmtId = "0";
          delete baseXf.applyNumberFormat;
        } else {
          baseXf.numFmtId = String(findOrAddNumberFormat(patch.numberFormat));
          baseXf.applyNumberFormat = "1";
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
  const match = sheetXml.match(cellOpenTagRegex(ref)) ?? sheetXml.match(cellSelfClosingRegex(ref));
  return match ? getXmlAttr(match[0], "s") : undefined;
}

function applyCellStyle(xml: string, addr: CellAddress, ref: string, styleIndex: number): string {
  const selfClose = cellSelfClosingRegex(ref);
  if (selfClose.test(xml)) {
    return maybeExpandDimension(
      xml.replace(selfClose, (cellXml) => setCellStyle(cellXml, styleIndex)),
      addr,
    );
  }
  const withChildren = cellWithChildrenRegex(ref);
  if (withChildren.test(xml)) {
    return maybeExpandDimension(
      xml.replace(withChildren, (cellXml) => setCellStyle(cellXml, styleIndex)),
      addr,
    );
  }
  return maybeExpandDimension(
    insertCell(xml, addr, ref, `<c r="${ref}" s="${styleIndex}"/>`),
    addr,
  );
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

/** Pull the existing `s="N"` style attribute off the target cell, if any. */
function readCellStyleAttr(sheetXml: string, ref: string): string {
  const match = sheetXml.match(cellOpenTagRegex(ref));
  if (!match) {
    const selfClosing = sheetXml.match(cellSelfClosingRegex(ref));
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

function applyWorksheetMerge(
  xml: string,
  range: ReturnType<typeof parseRange>,
  merged: boolean,
): string {
  if (!range) return xml;
  const rangeRef = XLSX.utils.encode_range({
    s: { r: range.start.row, c: range.start.col },
    e: { r: range.end.row, c: range.end.col },
  });
  const mergeCellsRe = /<mergeCells\b([^>]*)>([\s\S]*?)<\/mergeCells>/;
  const mergeCellsSelfClosingRe = /<mergeCells\b([^>]*)\/>/;
  const existing =
    mergeCellsRe.exec(xml) ??
    mergeCellsSelfClosingRe.exec(xml)?.map((value, index) => (index === 2 ? "" : value));
  const refs = existing ? readMergeRefs(existing[2] ?? "") : [];
  const nextRefs = refs.filter((ref) => ref.toUpperCase() !== rangeRef.toUpperCase());
  if (merged) nextRefs.push(rangeRef);

  const nextXml =
    nextRefs.length > 0
      ? `<mergeCells count="${nextRefs.length}">${nextRefs
          .map((ref) => `<mergeCell ref="${ref}"/>`)
          .join("")}</mergeCells>`
      : "";

  let updated = xml;
  if (existing) {
    updated = nextXml ? xml.replace(existing[0], nextXml) : xml.replace(existing[0], "");
  } else if (nextXml) {
    const sheetDataClose = "</sheetData>";
    const insertAt = xml.indexOf(sheetDataClose);
    if (insertAt === -1) throw new Error("Worksheet <sheetData> is not closed.");
    updated =
      xml.slice(0, insertAt + sheetDataClose.length) +
      nextXml +
      xml.slice(insertAt + sheetDataClose.length);
  }

  if (!merged) return updated;
  return maybeExpandDimension(maybeExpandDimension(updated, range.start), range.end);
}

function readMergeRefs(xml: string): string[] {
  const refs: string[] = [];
  const mergeRe = /<mergeCell\b[^>]*\bref="([^"]+)"[^>]*\/?>/g;
  let match = mergeRe.exec(xml);
  while (match) {
    refs.push(match[1] as string);
    match = mergeRe.exec(xml);
  }
  return refs;
}

function applyWorksheetColumnWidth(xml: string, col: number, widthPx: number | null): string {
  const colIndex = col + 1;
  const colXml =
    widthPx === null
      ? null
      : `<col min="${colIndex}" max="${colIndex}" width="${formatStyleNumber(
          Math.max(0.1, (widthPx - 5) / 7),
        )}" customWidth="1"/>`;
  const colsRe = /<cols\b[^>]*>([\s\S]*?)<\/cols>/;
  const colsMatch = colsRe.exec(xml);
  if (!colsMatch) {
    if (colXml === null) return xml;
    const insertAt = xml.indexOf("<sheetData");
    if (insertAt === -1) throw new Error("Worksheet has no <sheetData> element.");
    return `${xml.slice(0, insertAt)}<cols>${colXml}</cols>${xml.slice(insertAt)}`;
  }

  const nextCols = rewriteCols(colsMatch[1] ?? "", colIndex, colXml);
  if (nextCols.trim() === "") return xml.replace(colsRe, "");
  return xml.replace(colsRe, `<cols>${nextCols}</cols>`);
}

function rewriteCols(innerXml: string, colIndex: number, colXml: string | null): string {
  const parts: string[] = [];
  let cursor = 0;
  let inserted = false;
  const colRe = /<col\b[^>]*\/?>/g;
  let match = colRe.exec(innerXml);
  while (match) {
    parts.push(innerXml.slice(cursor, match.index));
    const tag = match[0];
    const min = Number.parseInt(getXmlAttr(tag, "min") ?? "", 10);
    const max = Number.parseInt(getXmlAttr(tag, "max") ?? "", 10);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      parts.push(tag);
    } else if (colIndex < min) {
      if (!inserted && colXml !== null) {
        parts.push(colXml);
        inserted = true;
      }
      parts.push(tag);
    } else if (colIndex > max) {
      parts.push(tag);
    } else {
      if (min < colIndex) parts.push(setColRange(tag, min, colIndex - 1));
      if (!inserted && colXml !== null) {
        parts.push(colXml);
        inserted = true;
      }
      if (colIndex < max) parts.push(setColRange(tag, colIndex + 1, max));
    }
    cursor = match.index + tag.length;
    match = colRe.exec(innerXml);
  }
  parts.push(innerXml.slice(cursor));
  if (!inserted && colXml !== null) parts.push(colXml);
  return parts.join("");
}

function setColRange(tag: string, min: number, max: number): string {
  return tag.replace(/\bmin="[^"]*"/, `min="${min}"`).replace(/\bmax="[^"]*"/, `max="${max}"`);
}

/**
 * Replace the target cell in the worksheet XML, creating the cell (and its row)
 * in ascending order when absent. Only the single `<c>` / `<row>` is touched.
 */
function applyCellEdit(xml: string, addr: CellAddress, ref: string, cellXml: string): string {
  const selfClose = cellSelfClosingRegex(ref);
  if (selfClose.test(xml)) {
    return maybeExpandDimension(xml.replace(selfClose, cellXml), addr);
  }
  const withChildren = cellWithChildrenRegex(ref);
  if (withChildren.test(xml)) {
    return maybeExpandDimension(xml.replace(withChildren, cellXml), addr);
  }
  return maybeExpandDimension(insertCell(xml, addr, ref, cellXml), addr);
}

function cellOpenTagRegex(ref: string): RegExp {
  return new RegExp(`<c\\b(?=[^>]*\\br="${escapeRegExp(ref)}"(?=[\\s/>]))[^>]*?>`);
}

function cellSelfClosingRegex(ref: string): RegExp {
  return new RegExp(`<c\\b(?=[^>]*\\br="${escapeRegExp(ref)}"(?=[\\s/>]))[^>]*?/>`);
}

function cellWithChildrenRegex(ref: string): RegExp {
  return new RegExp(`<c\\b(?=[^>]*\\br="${escapeRegExp(ref)}"(?=[\\s/>]))[^>]*?>[\\s\\S]*?</c>`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function getXmlAttr(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*"([^"]*)"`));
  return match ? match[1] : undefined;
}
