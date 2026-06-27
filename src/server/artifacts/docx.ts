import type JSZip from "jszip";
import {
  arrayOfRecords,
  asRecord,
  collectRecordsNamed,
  collectText,
  loadBoundedOoxmlPackage,
  normalizeWhitespace,
  readBoundedXmlPart,
  readMedia,
  stringValue,
} from "./ooxml";
import type {
  DocxHeading,
  DocxParagraph,
  DocxSectionText,
  DocxSnapshot,
  DocxTable,
  DocxTrackedChange,
} from "./types";

const MAX_STRUCTURAL_ITEMS = 100_000;

export async function extractDocxSnapshot(bytes: Uint8Array): Promise<DocxSnapshot> {
  const zip = await loadBoundedOoxmlPackage(bytes);
  const documentRoot = await readBoundedXmlPart(zip, "word/document.xml");
  const document = asRecord(documentRoot?.document);
  const body = asRecord(document?.body);
  if (!body) throw new Error("DOCX package is missing word/document.xml content.");

  const paragraphs: DocxParagraph[] = [];
  const headings: DocxHeading[] = [];
  for (const [index, paragraph] of arrayOfRecords(body.p).entries()) {
    const parsed = parseParagraph(paragraph, index);
    if (isHeading(parsed)) {
      headings.push({ ...parsed, level: headingLevel(parsed) });
    } else {
      paragraphs.push(parsed);
    }
  }

  const tables = arrayOfRecords(body.tbl).map(parseTable);
  const headers = await readSectionParts(zip, /^word\/header[^/]*\.xml$/i);
  const footers = await readSectionParts(zip, /^word\/footer[^/]*\.xml$/i);
  const trackedChanges = await readTrackedChanges(zip);
  enforceStructuralLimit(
    paragraphs.length +
      headings.length +
      tables.length +
      headers.length +
      footers.length +
      trackedChanges.length,
  );

  return {
    paragraphs,
    headings,
    tables,
    headers,
    footers,
    trackedChanges,
    media: await readMedia(zip, "word/media/"),
  };
}

function parseParagraph(paragraph: Record<string, unknown>, index: number): DocxParagraph {
  const properties = asRecord(paragraph.pPr);
  const styleNode = asRecord(properties?.pStyle);
  return {
    index,
    text: collectText(paragraph),
    style: stringValue(styleNode?.val ?? properties?.pStyle) ?? null,
  };
}

function isHeading(paragraph: DocxParagraph): boolean {
  return paragraph.style !== null && /^(heading\s*\d+|title|subtitle)$/i.test(paragraph.style);
}

function headingLevel(paragraph: DocxParagraph): number | null {
  const match = paragraph.style?.match(/^heading\s*(\d+)/i);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTable(table: Record<string, unknown>, index: number): DocxTable {
  const rows = arrayOfRecords(table.tr).map((row) =>
    arrayOfRecords(row.tc).map((cell) => {
      const texts = collectRecordsNamed(cell, "p").map((paragraph) => collectText(paragraph));
      return normalizeWhitespace(texts.filter(Boolean).join("\n"));
    }),
  );
  return { index, rows };
}

async function readSectionParts(zip: JSZip, pattern: RegExp): Promise<DocxSectionText[]> {
  const output: DocxSectionText[] = [];
  for (const part of Object.keys(zip.files)
    .filter((name) => pattern.test(name))
    .toSorted()) {
    const root = await readBoundedXmlPart(zip, part);
    const text = collectRecordsNamed(root, "p")
      .map((paragraph) => collectText(paragraph))
      .filter(Boolean)
      .join("\n");
    output.push({ part, text });
  }
  return output;
}

async function readTrackedChanges(zip: JSZip): Promise<DocxTrackedChange[]> {
  const changes: DocxTrackedChange[] = [];
  const parts = Object.keys(zip.files)
    .filter((name) =>
      /^word\/(document|header[^/]*|footer[^/]*|footnotes|endnotes)\.xml$/i.test(name),
    )
    .toSorted();
  for (const part of parts) {
    const root = await readBoundedXmlPart(zip, part);
    for (const [name, type] of [
      ["ins", "insertion"],
      ["del", "deletion"],
    ] as const) {
      for (const entry of collectRecordsNamed(root, name)) {
        changes.push({
          type,
          id: stringValue(entry.id) ?? null,
          author: stringValue(entry.author) ?? null,
          date: stringValue(entry.date) ?? null,
          text: collectText(entry, { includeDeleted: true }),
        });
      }
    }
  }
  return changes;
}

function enforceStructuralLimit(count: number): void {
  if (count > MAX_STRUCTURAL_ITEMS) {
    throw new Error(`DOCX structure exceeds the ${MAX_STRUCTURAL_ITEMS}-item limit.`);
  }
}
