import { describe, expect, test } from "bun:test";

import JSZip from "jszip";

import {
  ArtifactPreviewService,
  artifactPreviewSchema,
  MAX_INLINE_PREVIEW_BYTES,
  MAX_PREVIEW_TEXT_CHARS,
} from "../src/server/artifacts";
import { MAX_OOXML_ENTRIES, MAX_OOXML_TEXT_CHARS } from "../src/server/artifacts/ooxml";
import {
  artifactBlob,
  makeDocxFixture,
  makePptxFixture,
  makeXlsxFixture,
} from "./helpers/artifactOfficeFixtures";

describe("ArtifactPreviewService", () => {
  const service = new ArtifactPreviewService();

  test("returns typed text, image, PDF, and binary previews from immutable bytes", async () => {
    const text = await service.preview(artifactBlob("notes.txt", "hello\nworld"));
    expect(text).toMatchObject({ kind: "text", text: "hello\nworld", encoding: "utf-8" });

    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(320, 16);
    png.writeUInt32BE(200, 20);
    const image = await service.preview(artifactBlob("chart.png", png));
    expect(image).toMatchObject({ kind: "image", mimeType: "image/png", width: 320, height: 200 });
    if (image.kind === "image") expect(image.dataUrl).toStartWith("data:image/png;base64,");

    const pdf = await service.preview(
      artifactBlob(
        "report.pdf",
        "%PDF-1.7\n1 0 obj <</Type /Page>> endobj\n2 0 obj <</Type /Page>> endobj\n%%EOF",
      ),
    );
    expect(pdf).toMatchObject({ kind: "pdf", mimeType: "application/pdf", pageCount: 2 });

    const binary = await service.preview(artifactBlob("payload.bin", Buffer.from([0, 1, 2, 3, 4])));
    expect(binary).toMatchObject({
      kind: "binary",
      metadata: { filename: "payload.bin", sizeBytes: 5 },
    });

    for (const preview of [text, image, pdf, binary]) {
      expect(() => artifactPreviewSchema.parse(preview)).not.toThrow();
    }
  });

  test("returns structural DOCX, PPTX, and XLSX previews", async () => {
    const docx = await service.preview(
      artifactBlob(
        "report.docx",
        await makeDocxFixture({ heading: "Overview", paragraph: "Body copy" }),
      ),
    );
    expect(docx.kind).toBe("docx");
    if (docx.kind === "docx") {
      expect(docx.document.headings[0]?.text).toBe("Overview");
      expect(docx.document.paragraphs.some((paragraph) => paragraph.text === "Body copy")).toBe(
        true,
      );
      expect(docx.document.tables[0]?.rows).toEqual([["Cell"]]);
      expect(docx.document.headers[0]?.text).toBe("Header");
      expect(docx.document.trackedChanges[0]).toMatchObject({
        type: "insertion",
        author: "Ada",
      });
    }

    const pptx = await service.preview(
      artifactBlob(
        "deck.pptx",
        await makePptxFixture([{ id: "256", text: "Slide text", notes: "Speaker note" }]),
      ),
    );
    expect(pptx.kind).toBe("pptx");
    if (pptx.kind === "pptx") {
      expect(pptx.presentation.slides[0]).toMatchObject({
        id: "256",
        text: "Slide text",
        notes: "Speaker note",
      });
      expect(pptx.presentation.slides[0]?.shapes.length).toBeGreaterThan(0);
    }

    const xlsx = await service.preview(
      artifactBlob("model.xlsx", await makeXlsxFixture({ formula: "B2*4" })),
    );
    expect(xlsx.kind).toBe("xlsx");
    if (xlsx.kind === "xlsx") {
      const main = xlsx.workbook.sheets.find((sheet) => sheet.name === "Main");
      expect(main?.cells.find((cell) => cell.address === "C2")?.formula).toBe("B2*4");
      expect(main?.tables[0]?.name).toBe("DataTable");
      expect(main?.charts[0]?.title).toBe("Revenue");
    }

    for (const preview of [docx, pptx, xlsx]) {
      expect(() => artifactPreviewSchema.parse(preview)).not.toThrow();
    }
  });

  test("bounds text and inline image/PDF preview payloads", async () => {
    const text = await service.preview(
      artifactBlob("large.txt", "x".repeat(MAX_PREVIEW_TEXT_CHARS + 25)),
    );
    expect(text.kind).toBe("text");
    if (text.kind === "text") {
      expect(text.text).toHaveLength(MAX_PREVIEW_TEXT_CHARS);
      expect(text.warnings.join(" ")).toContain("capped");
    }

    const imageBytes = Buffer.alloc(MAX_INLINE_PREVIEW_BYTES + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
    const image = await service.preview(artifactBlob("large.png", imageBytes));
    expect(image.kind).toBe("binary");
    expect(image.warnings.join(" ")).toContain("not inlined");

    const pdfBytes = Buffer.alloc(MAX_INLINE_PREVIEW_BYTES + 1);
    Buffer.from("%PDF-").copy(pdfBytes);
    const pdf = await service.preview(artifactBlob("large.pdf", pdfBytes));
    expect(pdf.kind).toBe("binary");
    expect(pdf.warnings.join(" ")).toContain("not inlined");
  });

  test("degrades oversized Office XML to a binary preview with a warning", async () => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    zip.file("word/document.xml", "x".repeat(MAX_OOXML_TEXT_CHARS + 1));
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

    const preview = await service.preview(artifactBlob("oversized.docx", bytes));
    expect(preview.kind).toBe("binary");
    expect(preview.warnings.join(" ")).toContain("text limit");
  });

  test("degrades excessive Office archive entry counts without expanding entries", async () => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    for (let index = 0; index < MAX_OOXML_ENTRIES; index += 1) {
      zip.file(`word/media/entry-${index}.bin`, "");
    }
    const bytes = await zip.generateAsync({ type: "nodebuffer" });

    const preview = await service.preview(artifactBlob("too-many.docx", bytes));
    expect(preview.kind).toBe("binary");
    expect(preview.warnings.join(" ")).toContain("entry limit");
  });
});
