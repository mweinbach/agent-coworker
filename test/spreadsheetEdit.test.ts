import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

import { editSpreadsheetCell } from "../src/server/spreadsheetEdit";
import { previewSpreadsheetFile } from "../src/server/spreadsheetPreview";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-spreadsheet-edit-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// A hand-built OOXML package. We cannot use SheetJS to author a *styled* fixture
// (its community build does not write styles), so we zip the parts directly.
// Summary!B2 carries style index s="3" (a "$#,##0.00" number format) and there
// is a sentinel chart part that SheetJS would strip on a naive round-trip.
const WORKBOOK_PARTS: Record<string, string> = {
  "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
  "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Data" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
  "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  "xl/sharedStrings.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>`,
  "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Metric</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Revenue</t></is></c><c r="B2" s="3"><v>1</v></c></row></sheetData></worksheet>`,
  "xl/worksheets/sheet2.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c></row></sheetData></worksheet>`,
  // Sentinel: a part SheetJS read/write would drop. Proves we preserve charts.
  "xl/charts/chart1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:sentinel value="keep-me"/></c:chartSpace>`,
};

async function buildWorkbook(): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(WORKBOOK_PARTS)) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function entryBytes(buffer: Buffer): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(buffer);
  const map = new Map<string, string>();
  await Promise.all(
    Object.keys(zip.files)
      .filter((name) => !zip.files[name]?.dir)
      .map(async (name) => {
        const bytes = await zip.file(name)!.async("uint8array");
        map.set(name, Buffer.from(bytes).toString("base64"));
      }),
  );
  return map;
}

async function partText(filePath: string, part: string): Promise<string> {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  return zip.file(part)!.async("string");
}

describe("xlsx single-cell edit (lossless)", () => {
  test("changes the value, preserves the style index, and leaves all other parts byte-identical", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      const original = await buildWorkbook();
      await fs.writeFile(filePath, original);

      const result = await editSpreadsheetCell({
        cwd: dir,
        filePath,
        sheetName: "Summary",
        address: "B2",
        rawInput: "hello world",
      });
      expect(result).toEqual({ ok: true });

      // (a) value changed when re-read via SheetJS
      const preview = await previewSpreadsheetFile({ cwd: dir, filePath, sheetName: "Summary" });
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      const b2 = preview.preview.cells.flat().find((cell) => cell.address === "B2");
      expect(b2?.value).toBe("hello world");

      // (b) the style index survived on the edited cell
      const sheet1 = await partText(filePath, "xl/worksheets/sheet1.xml");
      expect(sheet1).toContain('r="B2"');
      expect(sheet1).toMatch(/<c[^>]*r="B2"[^>]*s="3"/);

      // (c) every other part is byte-identical (charts/styles/other sheets preserved)
      const before = await entryBytes(original);
      const after = await entryBytes(await fs.readFile(filePath));
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
      for (const [name, bytes] of before) {
        if (name === "xl/worksheets/sheet1.xml") continue;
        expect(after.get(name)).toBe(bytes);
      }
      // sentinel chart explicitly preserved
      expect(after.get("xl/charts/chart1.xml")).toBe(before.get("xl/charts/chart1.xml"));
    });
  });

  test("resolves the correct worksheet part by sheet name", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      await fs.writeFile(filePath, await buildWorkbook());

      const result = await editSpreadsheetCell({
        cwd: dir,
        filePath,
        sheetName: "Data",
        address: "A1",
        rawInput: "identifier",
      });
      expect(result).toEqual({ ok: true });

      // Data → sheet2.xml changed; Summary → sheet1.xml untouched.
      expect(await partText(filePath, "xl/worksheets/sheet2.xml")).toContain("identifier");
      expect(await partText(filePath, "xl/worksheets/sheet1.xml")).toContain("Revenue");
      expect(await partText(filePath, "xl/worksheets/sheet1.xml")).not.toContain("identifier");
    });
  });

  test("creates a missing cell in column order and stays valid", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      await fs.writeFile(filePath, await buildWorkbook());

      const result = await editSpreadsheetCell({
        cwd: dir,
        filePath,
        sheetName: "Summary",
        address: "C1",
        rawInput: "Tail",
      });
      expect(result).toEqual({ ok: true });

      const sheet1 = await partText(filePath, "xl/worksheets/sheet1.xml");
      // C1 inserted after B1 within row 1
      expect(sheet1).toMatch(/r="B1"[\s\S]*r="C1"/);

      const preview = await previewSpreadsheetFile({ cwd: dir, filePath, sheetName: "Summary" });
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.preview.cells.flat().find((c) => c.address === "C1")?.value).toBe("Tail");
    });
  });

  test("creates a missing row in row order", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      await fs.writeFile(filePath, await buildWorkbook());

      const result = await editSpreadsheetCell({
        cwd: dir,
        filePath,
        sheetName: "Summary",
        address: "A5",
        rawInput: "footer",
      });
      expect(result).toEqual({ ok: true });

      const sheet1 = await partText(filePath, "xl/worksheets/sheet1.xml");
      expect(sheet1).toMatch(/r="2"[\s\S]*<row r="5">/);
      const preview = await previewSpreadsheetFile({ cwd: dir, filePath, sheetName: "Summary" });
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.preview.cells.flat().find((c) => c.address === "A5")?.value).toBe("footer");
    });
  });

  test("stores a formula and a number with the right cell shape", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      await fs.writeFile(filePath, await buildWorkbook());

      expect(
        await editSpreadsheetCell({
          cwd: dir,
          filePath,
          sheetName: "Summary",
          address: "B2",
          rawInput: '=A2&" x"',
        }),
      ).toEqual({ ok: true });
      let sheet1 = await partText(filePath, "xl/worksheets/sheet1.xml");
      expect(sheet1).toMatch(/<c[^>]*r="B2"[^>]*s="3"><f>A2&amp;" x"<\/f><\/c>/);

      expect(
        await editSpreadsheetCell({
          cwd: dir,
          filePath,
          sheetName: "Summary",
          address: "B2",
          rawInput: "42.5",
        }),
      ).toEqual({ ok: true });
      sheet1 = await partText(filePath, "xl/worksheets/sheet1.xml");
      expect(sheet1).toMatch(/<c[^>]*r="B2"[^>]*s="3"><v>42.5<\/v><\/c>/);
    });
  });

  test("blanking a cell keeps its style index", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      await fs.writeFile(filePath, await buildWorkbook());

      expect(
        await editSpreadsheetCell({
          cwd: dir,
          filePath,
          sheetName: "Summary",
          address: "B2",
          rawInput: "",
        }),
      ).toEqual({ ok: true });
      const sheet1 = await partText(filePath, "xl/worksheets/sheet1.xml");
      expect(sheet1).toMatch(/<c r="B2" s="3"\/>/);
    });
  });

  test("reports not_found for an unknown sheet", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      await fs.writeFile(filePath, await buildWorkbook());
      const result = await editSpreadsheetCell({
        cwd: dir,
        filePath,
        sheetName: "Nope",
        address: "A1",
        rawInput: "x",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("not_found");
    });
  });
});

describe("csv single-cell edit (lossless)", () => {
  // CSV uses minimal quoting (the common Excel-export form). Conservative
  // re-quoting reproduces minimally-quoted fields byte-for-byte.
  const SAMPLE = 'name,note,amount\r\nAlice,"quoted, comma",10\r\nBob,"line one\nline two",';

  test("edits one cell, preserving CRLF, quoting, embedded newline, and no trailing newline", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "data.csv");
      await fs.writeFile(filePath, SAMPLE, "utf8");

      const result = await editSpreadsheetCell({
        cwd: dir,
        filePath,
        address: "A1",
        rawInput: "label",
      });
      expect(result).toEqual({ ok: true });

      const out = await fs.readFile(filePath, "utf8");
      expect(out).toBe(
        'label,note,amount\r\nAlice,"quoted, comma",10\r\nBob,"line one\nline two",',
      );
    });
  });

  test("quotes a value that newly requires it", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "data.csv");
      await fs.writeFile(filePath, "a,b\nc,d\n", "utf8");

      const result = await editSpreadsheetCell({
        cwd: dir,
        filePath,
        address: "A1",
        rawInput: "x,y",
      });
      expect(result).toEqual({ ok: true });
      expect(await fs.readFile(filePath, "utf8")).toBe('"x,y",b\nc,d\n');
    });
  });

  test("preserves a UTF-8 BOM", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "data.csv");
      await fs.writeFile(filePath, "﻿a,b\nc,d\n", "utf8");

      expect(
        await editSpreadsheetCell({ cwd: dir, filePath, address: "B2", rawInput: "Z" }),
      ).toEqual({
        ok: true,
      });
      const out = await fs.readFile(filePath, "utf8");
      expect(out.charCodeAt(0)).toBe(0xfeff);
      expect(out).toBe("﻿a,b\nc,Z\n");
    });
  });

  test("extends rows and columns when editing beyond the current extent", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "data.csv");
      await fs.writeFile(filePath, "a,b\n", "utf8");

      expect(
        await editSpreadsheetCell({ cwd: dir, filePath, address: "C3", rawInput: "9" }),
      ).toEqual({
        ok: true,
      });
      // Only the target row is widened; intermediate rows are blank; the
      // original trailing newline is preserved.
      expect(await fs.readFile(filePath, "utf8")).toBe("a,b\n\n,,9\n");
    });
  });
});

describe("spreadsheet edit guards", () => {
  test("rejects unsupported extensions", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "notes.txt");
      await fs.writeFile(filePath, "hi", "utf8");
      const result = await editSpreadsheetCell({
        cwd: dir,
        filePath,
        address: "A1",
        rawInput: "x",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("unsupported_format");
    });
  });

  test("rejects an invalid cell address", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "data.csv");
      await fs.writeFile(filePath, "a,b\n", "utf8");
      const result = await editSpreadsheetCell({
        cwd: dir,
        filePath,
        address: "??",
        rawInput: "x",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("parse_error");
    });
  });
});
