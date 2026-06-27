import path from "node:path";

import JSZip from "jszip";
import * as XLSX from "xlsx";
import type { ArtifactBlobInput } from "../../src/server/artifacts";
import { resolveWorksheetPart } from "../../src/server/spreadsheetOoxml";

export function artifactBlob(
  filename: string,
  bytes: Uint8Array | string,
  mimeType?: string,
): ArtifactBlobInput {
  return {
    filename,
    bytes: typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes,
    ...(mimeType ? { mimeType } : {}),
  };
}

export async function makeDocxFixture(
  options: {
    heading?: string;
    paragraph?: string;
    tableCell?: string;
    header?: string;
    footer?: string;
    trackedText?: string;
    media?: string;
  } = {},
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${xml(options.heading ?? "Heading")}</w:t></w:r></w:p>
  <w:p><w:r><w:t>${xml(options.paragraph ?? "Paragraph")}</w:t></w:r></w:p>
  <w:tbl><w:tr><w:tc><w:p><w:r><w:t>${xml(options.tableCell ?? "Cell")}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  <w:p><w:ins w:id="1" w:author="Ada" w:date="2026-01-01T00:00:00Z"><w:r><w:t>${xml(options.trackedText ?? "Inserted")}</w:t></w:r></w:ins></w:p>
</w:body></w:document>`,
  );
  zip.file(
    "word/header1.xml",
    `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>${xml(options.header ?? "Header")}</w:t></w:r></w:p></w:hdr>`,
  );
  zip.file(
    "word/footer1.xml",
    `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>${xml(options.footer ?? "Footer")}</w:t></w:r></w:p></w:ftr>`,
  );
  zip.file("word/media/image1.png", Buffer.from(options.media ?? "image-one"));
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export type PptxFixtureSlide = {
  id: string;
  text: string;
  notes?: string;
  media?: string;
  shapeName?: string;
};

export async function makePptxFixture(slides: PptxFixtureSlide[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
  );
  zip.file(
    "ppt/presentation.xml",
    `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slides
      .map((slide, index) => `<p:sldId id="${xml(slide.id)}" r:id="rId${index + 1}"/>`)
      .join("")}</p:sldIdLst></p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    relationships(
      slides.map((_, index) => ({
        id: `rId${index + 1}`,
        type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
        target: `slides/slide${index + 1}.xml`,
      })),
    ),
  );

  for (const [index, slide] of slides.entries()) {
    const number = index + 1;
    const stableNumber = Number.parseInt(slide.id, 10) || number;
    const stableFileId = slide.id.replace(/[^A-Za-z0-9_-]/g, "_");
    zip.file(
      `ppt/slides/slide${number}.xml`,
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="${stableNumber}" name="${xml(slide.shapeName ?? `Shape ${stableFileId}`)}"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${stableNumber * 10}" y="20"/><a:ext cx="300" cy="400"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>${xml(slide.text)}</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr id="${stableNumber + 100}" name="Picture ${stableFileId}"/></p:nvPicPr></p:pic></p:spTree></p:cSld></p:sld>`,
    );
    zip.file(
      `ppt/slides/_rels/slide${number}.xml.rels`,
      relationships([
        {
          id: "rIdNotes",
          type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide",
          target: `../notesSlides/notesSlide${stableFileId}.xml`,
        },
        {
          id: "rIdImage",
          type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
          target: `../media/image${stableFileId}.png`,
        },
      ]),
    );
    zip.file(
      `ppt/notesSlides/notesSlide${stableFileId}.xml`,
      `<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${xml(slide.notes ?? "")}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
    );
    zip.file(`ppt/media/image${stableFileId}.png`, Buffer.from(slide.media ?? `image-${slide.id}`));
  }
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export async function makeXlsxFixture(
  options: {
    value?: number;
    formula?: string;
    numberFormat?: string;
    merge?: string;
    width?: number;
    tableRef?: string;
    chartTitle?: string;
    sheets?: string[];
  } = {},
): Promise<Buffer> {
  const workbook = XLSX.utils.book_new();
  const sheetNames = options.sheets ?? ["Main", "Other"];
  for (const name of sheetNames) {
    const sheet =
      name === "Main"
        ? XLSX.utils.aoa_to_sheet([
            ["Metric", "Value", "Formula"],
            ["Revenue", options.value ?? 10, { f: options.formula ?? "B2*2", v: 20, t: "n" }],
          ])
        : XLSX.utils.aoa_to_sheet([[name], [1]]);
    if (name === "Main") {
      sheet["!merges"] = [XLSX.utils.decode_range(options.merge ?? "A1:B1")];
      sheet["!cols"] = [{ wch: options.width ?? 12 }, { wch: 10 }, { wch: 10 }];
      if (sheet.B2) sheet.B2.z = options.numberFormat ?? "$0.00";
    }
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const zip = await JSZip.loadAsync(bytes);
  const worksheetPart = await resolveWorksheetPart(zip, "Main");
  if (!worksheetPart) throw new Error("Fixture workbook is missing Main worksheet");
  const worksheet = await zip.file(worksheetPart)?.async("string");
  if (!worksheet) throw new Error("Fixture workbook worksheet could not be read");
  const withRelationshipNamespace = worksheet.includes("xmlns:r=")
    ? worksheet
    : worksheet.replace(
        /<worksheet\b/,
        '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
      );
  zip.file(
    worksheetPart,
    withRelationshipNamespace.replace(
      "</worksheet>",
      '<drawing r:id="rIdDrawing"/><tableParts count="1"><tablePart r:id="rIdTable"/></tableParts></worksheet>',
    ),
  );
  const worksheetRels = path.posix.join(
    path.posix.dirname(worksheetPart),
    "_rels",
    `${path.posix.basename(worksheetPart)}.rels`,
  );
  zip.file(
    worksheetRels,
    relationships([
      {
        id: "rIdTable",
        type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/table",
        target: "../tables/table1.xml",
      },
      {
        id: "rIdDrawing",
        type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing",
        target: "../drawings/drawing1.xml",
      },
    ]),
  );
  zip.file(
    "xl/tables/table1.xml",
    `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="DataTable" displayName="DataTable" ref="${xml(options.tableRef ?? "A1:C2")}"/>`,
  );
  zip.file(
    "xl/drawings/drawing1.xml",
    `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:row>0</xdr:row></xdr:from><xdr:to><xdr:col>8</xdr:col><xdr:row>12</xdr:row></xdr:to><xdr:graphicFrame><a:graphic><a:graphicData><c:chart r:id="rIdChart"/></a:graphicData></a:graphic></xdr:graphicFrame></xdr:twoCellAnchor></xdr:wsDr>`,
  );
  zip.file(
    "xl/drawings/_rels/drawing1.xml.rels",
    relationships([
      {
        id: "rIdChart",
        type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart",
        target: "../charts/chart1.xml",
      },
    ]),
  );
  zip.file(
    "xl/charts/chart1.xml",
    `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>${xml(options.chartTitle ?? "Revenue")}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart/></c:plotArea></c:chart></c:chartSpace>`,
  );
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function relationships(entries: Array<{ id: string; type: string; target: string }>): string {
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(
      (entry) =>
        `<Relationship Id="${xml(entry.id)}" Type="${xml(entry.type)}" Target="${xml(entry.target)}"/>`,
    )
    .join("")}</Relationships>`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
