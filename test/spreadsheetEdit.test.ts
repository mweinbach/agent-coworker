import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import {
  readSpreadsheetWorkbookSnapshot,
  spreadsheetFileVersionFromStat,
} from "../src/server/spreadsheet/read";
import { parseAddress, parseRange } from "../src/server/spreadsheet/util";
import { patchSpreadsheetBatch } from "../src/server/spreadsheet/write";

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

async function buildWorkbook(overrides: Record<string, string> = {}): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries({ ...WORKBOOK_PARTS, ...overrides })) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function primeSheetJsColumnMetrics(maxDigitWidth: number): void {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["Other workbook"]]);
  sheet["!cols"] = [{ wpx: 140, MDW: maxDigitWidth }];
  XLSX.utils.book_append_sheet(workbook, sheet, "Other");
  XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
}

async function buildFormulaWorkbook(): Promise<Buffer> {
  const zip = new JSZip();
  const parts = {
    ...WORKBOOK_PARTS,
    "[Content_Types].xml": WORKBOOK_PARTS["[Content_Types].xml"].replace(
      "</Types>",
      '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>',
    ),
    "xl/workbook.xml": WORKBOOK_PARTS["xl/workbook.xml"].replace(
      "</workbook>",
      '<calcPr calcId="1"/></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": WORKBOOK_PARTS["xl/_rels/workbook.xml.rels"].replace(
      "</Relationships>",
      '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>',
    ),
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C1"/><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="C1"><f>A1+B1</f><v>3</v></c></row></sheetData></worksheet>`,
    "xl/calcChain.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="C1" i="1"/></calcChain>`,
  };
  for (const [name, content] of Object.entries(parts)) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function buildWorkbookWithoutStyles(): Promise<Buffer> {
  const zip = new JSZip();
  const parts = {
    ...WORKBOOK_PARTS,
    "[Content_Types].xml": WORKBOOK_PARTS["[Content_Types].xml"].replace(
      /<Override PartName="\/xl\/styles\.xml"[^>]*\/>/,
      "",
    ),
    "xl/_rels/workbook.xml.rels": WORKBOOK_PARTS["xl/_rels/workbook.xml.rels"].replace(
      /<Relationship Id="rId3" Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/styles" Target="styles\.xml"\/>/,
      "",
    ),
  };
  delete parts["xl/styles.xml"];
  for (const [name, content] of Object.entries(parts)) {
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

async function readSheetCells(cwd: string, filePath: string, sheetName: string) {
  const snapshot = await readSpreadsheetWorkbookSnapshot({ cwd, filePath, sheetName });
  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok) return [];
  return snapshot.workbook.sheets.find((sheet) => sheet.name === sheetName)?.cells ?? [];
}

async function readSheetMergedRanges(cwd: string, filePath: string, sheetName: string) {
  const snapshot = await readSpreadsheetWorkbookSnapshot({ cwd, filePath, sheetName });
  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok) return [];
  return snapshot.workbook.sheets.find((sheet) => sheet.name === sheetName)?.mergedCells ?? [];
}

async function readSheetColumnWidths(cwd: string, filePath: string, sheetName: string) {
  const snapshot = await readSpreadsheetWorkbookSnapshot({ cwd, filePath, sheetName });
  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok) return [];
  return snapshot.workbook.sheets.find((sheet) => sheet.name === sheetName)?.columnWidths ?? [];
}

const editSpreadsheetCell = (req: {
  cwd: string;
  filePath: string;
  sheetName?: string;
  address: string;
  rawInput: string;
}) =>
  patchSpreadsheetBatch({
    cwd: req.cwd,
    filePath: req.filePath,
    operations: [
      {
        type: "cell",
        ...(req.sheetName ? { sheetName: req.sheetName } : {}),
        address: req.address,
        rawInput: req.rawInput,
      },
    ],
  });

const formatSpreadsheetRange = (req: {
  cwd: string;
  filePath: string;
  sheetName?: string;
  range: string;
  style: Parameters<typeof patchSpreadsheetBatch>[0]["operations"][number] extends {
    type: "format";
    style: infer Style;
  }
    ? Style
    : never;
}) =>
  patchSpreadsheetBatch({
    cwd: req.cwd,
    filePath: req.filePath,
    operations: [
      {
        type: "format",
        ...(req.sheetName ? { sheetName: req.sheetName } : {}),
        range: req.range,
        style: req.style,
      },
    ],
  });

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
      const cells = await readSheetCells(dir, filePath, "Summary");
      const b2 = cells.find((cell) => cell.address === "B2");
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

      const cells = await readSheetCells(dir, filePath, "Summary");
      expect(cells.find((cell) => cell.address === "C1")?.value).toBe("Tail");
    });
  });

  test("matches edited XLSX cell addresses exactly", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      const workbook = await buildWorkbook();
      const zip = await JSZip.loadAsync(workbook);
      zip.file(
        "xl/worksheets/sheet1.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:AA10"/><sheetData><row r="1"><c r="AA1" t="inlineStr"><is><t>wide</t></is></c></row><row r="10"><c r="A10" t="inlineStr"><is><t>lower</t></is></c></row></sheetData></worksheet>`,
      );
      await fs.writeFile(filePath, await zip.generateAsync({ type: "nodebuffer" }));

      expect(
        await editSpreadsheetCell({
          cwd: dir,
          filePath,
          sheetName: "Summary",
          address: "A1",
          rawInput: "top",
        }),
      ).toEqual({ ok: true });

      const cells = await readSheetCells(dir, filePath, "Summary");
      expect(cells.find((cell) => cell.address === "A1")?.value).toBe("top");
      expect(cells.find((cell) => cell.address === "A10")?.value).toBe("lower");
      expect(cells.find((cell) => cell.address === "AA1")?.value).toBe("wide");
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
      const cells = await readSheetCells(dir, filePath, "Summary");
      expect(cells.find((cell) => cell.address === "A5")?.value).toBe("footer");
    });
  });

  test.each(["cell", "format"] as const)(
    "expands a self-closing row before applying a %s patch",
    async (type) => {
      await withTempDir(async (dir) => {
        const filePath = path.join(dir, "empty-row.xlsx");
        const sheetXml = WORKBOOK_PARTS["xl/worksheets/sheet1.xml"].replace(
          /<row r="1">[\s\S]*?<\/row>/,
          '<row r="1" ht="24" customHeight="1"/>',
        );
        await fs.writeFile(filePath, await buildWorkbook({ "xl/worksheets/sheet1.xml": sheetXml }));

        const operation =
          type === "cell"
            ? { type, address: "A1", rawInput: "Inserted" }
            : { type, range: "A1", style: { bold: true } };
        expect(
          await patchSpreadsheetBatch({ cwd: dir, filePath, operations: [operation] }),
        ).toEqual({ ok: true });

        const xml = await partText(filePath, "xl/worksheets/sheet1.xml");
        const rows = new XMLParser({ ignoreAttributes: false }).parse(xml).worksheet.sheetData.row;
        expect(rows[0]).toMatchObject({
          "@_r": "1",
          "@_ht": "24",
          "@_customHeight": "1",
          c: { "@_r": "A1" },
        });
        expect(rows[1].c.map((cell: { "@_r": string }) => cell["@_r"])).toEqual(["A2", "B2"]);
      });
    },
  );

  test("edits a self-closing final row without requiring a later closing tag", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "empty-final-row.xlsx");
      await fs.writeFile(
        filePath,
        await buildWorkbook({
          "xl/worksheets/sheet1.xml": WORKBOOK_PARTS["xl/worksheets/sheet1.xml"].replace(
            /<row r="2">[\s\S]*?<\/row>/,
            '<row r="2"/>',
          ),
        }),
      );

      expect(
        await editSpreadsheetCell({ cwd: dir, filePath, address: "A2", rawInput: "Last" }),
      ).toEqual({ ok: true });
      const cells = await readSheetCells(dir, filePath, "Summary");
      expect(cells.find((cell) => cell.address === "A2")?.value).toBe("Last");
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

  test("invalidates formula caches and calc chain after cell edits", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "formula.xlsx");
      await fs.writeFile(filePath, await buildFormulaWorkbook());

      expect(
        await editSpreadsheetCell({
          cwd: dir,
          filePath,
          sheetName: "Summary",
          address: "A1",
          rawInput: "10",
        }),
      ).toEqual({ ok: true });

      const sheet1 = await partText(filePath, "xl/worksheets/sheet1.xml");
      expect(sheet1).toContain('<c r="C1"><f>A1+B1</f></c>');
      const workbookXml = await partText(filePath, "xl/workbook.xml");
      expect(workbookXml).toContain('fullCalcOnLoad="1"');
      expect(workbookXml).toContain('forceFullCalc="1"');
      const rels = await partText(filePath, "xl/_rels/workbook.xml.rels");
      expect(rels).not.toContain("calcChain");
      const contentTypes = await partText(filePath, "[Content_Types].xml");
      expect(contentTypes).not.toContain("calcChain.xml");

      const zip = await JSZip.loadAsync(await fs.readFile(filePath));
      expect(zip.file("xl/calcChain.xml")).toBeNull();
      const cells = await readSheetCells(dir, filePath, "Summary");
      const formula = cells.find((cell) => cell.address === "C1");
      expect(formula?.formula).toBe("A1+B1");
      expect(formula?.value).not.toBe("3");
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

  test("formats a range with number formats while preserving formulas and workbook parts", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      const original = await buildWorkbook();
      await fs.writeFile(filePath, original);

      expect(
        await formatSpreadsheetRange({
          cwd: dir,
          filePath,
          sheetName: "Summary",
          range: "A1:B2",
          style: {
            bold: true,
            italic: true,
            fontSize: 14,
            fillColor: "#FFF2CC",
            textColor: "#1F4E79",
            numberFormat: "0.0%",
            horizontalAlign: "center",
          },
        }),
      ).toEqual({ ok: true });

      const cells = await readSheetCells(dir, filePath, "Summary");
      const a1 = cells.find((cell) => cell.address === "A1");
      const b2 = cells.find((cell) => cell.address === "B2");
      for (const cell of [a1, b2]) {
        expect(cell?.style).toMatchObject({
          bold: true,
          italic: true,
          fontSize: 14,
          fillColor: "#FFF2CC",
          textColor: "#1F4E79",
          horizontalAlign: "center",
          numberFormat: "0.0%",
        });
      }
      expect(await partText(filePath, "xl/styles.xml")).toContain(
        'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
      );

      const before = await entryBytes(original);
      const after = await entryBytes(await fs.readFile(filePath));
      expect(after.get("xl/charts/chart1.xml")).toBe(before.get("xl/charts/chart1.xml"));
      expect(after.get("xl/worksheets/sheet2.xml")).toBe(before.get("xl/worksheets/sheet2.xml"));
    });
  });

  test("registers a created styles part when formatting a minimal workbook", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "minimal.xlsx");
      await fs.writeFile(filePath, await buildWorkbookWithoutStyles());

      expect(
        await formatSpreadsheetRange({
          cwd: dir,
          filePath,
          sheetName: "Summary",
          range: "A1",
          style: { bold: true },
        }),
      ).toEqual({ ok: true });

      const zip = await JSZip.loadAsync(await fs.readFile(filePath));
      expect(zip.file("xl/styles.xml")).not.toBeNull();
      expect(await partText(filePath, "[Content_Types].xml")).toContain(
        'PartName="/xl/styles.xml"',
      );
      expect(await partText(filePath, "xl/_rels/workbook.xml.rels")).toContain(
        "/relationships/styles",
      );
      expect(await partText(filePath, "xl/worksheets/sheet1.xml")).toMatch(
        /<c[^>]*r="A1"[^>]*s="\d+"/,
      );
    });
  });

  test.each(["", "s:"])(
    "preserves empty elements and namespaces in %sstylesheets",
    async (prefix) => {
      await withTempDir(async (dir) => {
        const filePath = path.join(dir, "styled.xlsx");
        let stylesXml = WORKBOOK_PARTS["xl/styles.xml"]
          .replace(
            "<styleSheet ",
            '<styleSheet xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x14="urn:style-extension" mc:Ignorable="x14" ',
          )
          .replace("<font>", "<font><b/><i/><u/>")
          .replace(
            "</styleSheet>",
            '<extLst><ext uri="urn:sentinel"><x14:sentinel value="keep-me"/></ext></extLst></styleSheet>',
          );
        if (prefix) {
          stylesXml = stylesXml
            .replace('xmlns="', `xmlns:${prefix.slice(0, -1)}="`)
            .replace(/<(\/?)([A-Za-z][\w-]*)(?=[\s/>])/g, `<$1${prefix}$2`);
        }
        await fs.writeFile(filePath, await buildWorkbook({ "xl/styles.xml": stylesXml }));

        expect(
          await patchSpreadsheetBatch({
            cwd: dir,
            filePath,
            operations: [{ type: "format", range: "B2", style: { fillColor: "#FF0000" } }],
          }),
        ).toEqual({ ok: true });

        // Use a parser that distinguishes attributes from elements: the preview's
        // flattened attribute representation would conceal this corruption.
        const parser = new XMLParser({ ignoreAttributes: false });
        const before = parser.parse(stylesXml)[`${prefix}styleSheet`];
        const after = parser.parse(await partText(filePath, "xl/styles.xml"))[
          `${prefix}styleSheet`
        ];
        expect(after[`${prefix}fonts`]).toEqual(before[`${prefix}fonts`]);
        expect(after[`${prefix}borders`]).toEqual(before[`${prefix}borders`]);
        expect(after[`${prefix}extLst`]).toEqual(before[`${prefix}extLst`]);
        expect(after["@_xmlns:mc"]).toBe(before["@_xmlns:mc"]);
        expect(after["@_xmlns:x14"]).toBe(before["@_xmlns:x14"]);
        expect(after["@_mc:Ignorable"]).toBe("x14");
      });
    },
  );

  test("applies batched Univer-style value, formula, and format patches", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      await fs.writeFile(filePath, await buildWorkbook());

      const result = await patchSpreadsheetBatch({
        cwd: dir,
        filePath,
        operations: [
          {
            type: "cell",
            sheetName: "Summary",
            address: "A1",
            rawInput: "Updated metric",
          },
          {
            type: "cell",
            sheetName: "Summary",
            address: "B2",
            rawInput: "=1+2",
          },
          {
            type: "format",
            sheetName: "Summary",
            range: "A1:B2",
            style: {
              bold: true,
              italic: true,
              fontSize: 16,
              fillColor: "#FFF2CC",
              textColor: "#1F4E79",
              numberFormat: "0.0%",
              horizontalAlign: "center",
            },
          },
        ],
      });
      expect(result).toEqual({ ok: true });

      const cells = await readSheetCells(dir, filePath, "Summary");
      const a1 = cells.find((cell) => cell.address === "A1");
      const b2 = cells.find((cell) => cell.address === "B2");
      expect(a1?.value).toBe("Updated metric");
      expect(b2?.formula).toBe("1+2");
      for (const cell of [a1, b2]) {
        expect(cell?.style).toMatchObject({
          bold: true,
          italic: true,
          fontSize: 16,
          fillColor: "#FFF2CC",
          textColor: "#1F4E79",
          horizontalAlign: "center",
          numberFormat: "0.0%",
        });
      }
    });
  });

  test("applies batched merge and unmerge patches", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      await fs.writeFile(filePath, await buildWorkbook());

      expect(
        await patchSpreadsheetBatch({
          cwd: dir,
          filePath,
          operations: [{ type: "merge", sheetName: "Summary", range: "A1:B1", merged: true }],
        }),
      ).toEqual({ ok: true });
      expect(
        (await readSheetMergedRanges(dir, filePath, "Summary")).map((range) => range.ref),
      ).toContain("A1:B1");

      expect(
        await patchSpreadsheetBatch({
          cwd: dir,
          filePath,
          operations: [{ type: "merge", sheetName: "Summary", range: "A1:B1", merged: false }],
        }),
      ).toEqual({ ok: true });
      expect(
        (await readSheetMergedRanges(dir, filePath, "Summary")).map((range) => range.ref),
      ).not.toContain("A1:B1");
    });
  });

  test("persists column width patches", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      await fs.writeFile(filePath, await buildWorkbook());

      expect(
        await patchSpreadsheetBatch({
          cwd: dir,
          filePath,
          operations: [{ type: "columnWidth", sheetName: "Summary", col: 1, widthPx: 140 }],
        }),
      ).toEqual({ ok: true });

      const widths = await readSheetColumnWidths(dir, filePath, "Summary");
      expect(widths.find((width) => width.col === 1)).toEqual({
        col: 1,
        widthChars: 19.29,
        widthPx: 140,
      });
      expect(await partText(filePath, "xl/worksheets/sheet1.xml")).toContain(
        '<col min="2" max="2" width="20" customWidth="1"/>',
      );
    });
  });

  test.each([6, 14, 7])(
    "reads column widths independently of another workbook's %ipx maximum digit width",
    async (maxDigitWidth) => {
      await withTempDir(async (dir) => {
        const filePath = path.join(dir, "model.xlsx");
        const columns =
          '<cols><col min="1" max="1" width="20"/><col min="2" max="2" width="25.7109375"/></cols>';
        await fs.writeFile(
          filePath,
          await buildWorkbook({
            "xl/worksheets/sheet1.xml": WORKBOOK_PARTS["xl/worksheets/sheet1.xml"].replace(
              "<sheetData>",
              `${columns}<sheetData>`,
            ),
          }),
        );
        primeSheetJsColumnMetrics(maxDigitWidth);

        expect(await readSheetColumnWidths(dir, filePath, "Summary")).toEqual([
          { col: 0, widthChars: 19.29, widthPx: 140 },
          { col: 1, widthChars: 25, widthPx: 180 },
        ]);
      });
    },
  );

  test("round-trips repeated first-column resizes without changing other column ranges", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      const untouchedColumns =
        '\n<!--preserve column metadata and order--><col min="2" max="4" width="25.7109375" style="3" hidden="1" outlineLevel="2" customWidth="1"/>\n';
      await fs.writeFile(
        filePath,
        await buildWorkbook({
          "xl/worksheets/sheet1.xml": WORKBOOK_PARTS["xl/worksheets/sheet1.xml"].replace(
            "<sheetData>",
            `<cols><col min="1" max="1" width="20"/>${untouchedColumns}</cols><sheetData>`,
          ),
        }),
      );

      for (const [widthPx, encodedWidth] of [
        [96, "13.7109375"],
        [140, "20"],
        [180, "25.7109375"],
        [140, "20"],
      ] as const) {
        primeSheetJsColumnMetrics(14);
        expect(
          await patchSpreadsheetBatch({
            cwd: dir,
            filePath,
            operations: [{ type: "columnWidth", sheetName: "Summary", col: 0, widthPx }],
          }),
        ).toEqual({ ok: true });
        const widths = await readSheetColumnWidths(dir, filePath, "Summary");
        expect(widths.find((width) => width.col === 0)?.widthPx).toBe(widthPx);
        expect(widths.find((width) => width.col === 1)).toEqual({
          col: 1,
          widthChars: 25,
          widthPx: 180,
        });
        expect(await partText(filePath, "xl/worksheets/sheet1.xml")).toContain(
          `<cols><col min="1" max="1" width="${encodedWidth}" customWidth="1"/>${untouchedColumns}</cols>`,
        );
      }
    });
  });

  test("rejects column widths beyond Excel's limit without rewriting the workbook", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      const original = await buildWorkbook();
      await fs.writeFile(filePath, original);
      const result = await patchSpreadsheetBatch({
        cwd: dir,
        filePath,
        operations: [{ type: "columnWidth", sheetName: "Summary", col: 0, widthPx: 1786 }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("parse_error");
      expect(await fs.readFile(filePath)).toEqual(original);
    });
  });

  test("ignores out-of-range column widths in malformed workbooks", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      await fs.writeFile(
        filePath,
        await buildWorkbook({
          "xl/worksheets/sheet1.xml": WORKBOOK_PARTS["xl/worksheets/sheet1.xml"].replace(
            "<sheetData>",
            '<cols><col min="1" max="1" width="1e308"/><col min="2" max="2" width="256"/></cols><sheetData>',
          ),
        }),
      );
      expect(await readSheetColumnWidths(dir, filePath, "Summary")).toEqual([]);
    });
  });

  test("resets custom column width patches", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      await fs.writeFile(filePath, await buildWorkbook());

      expect(
        await patchSpreadsheetBatch({
          cwd: dir,
          filePath,
          operations: [{ type: "columnWidth", sheetName: "Summary", col: 1, widthPx: 180 }],
        }),
      ).toEqual({ ok: true });
      expect((await readSheetColumnWidths(dir, filePath, "Summary")).some((w) => w.col === 1)).toBe(
        true,
      );

      expect(
        await patchSpreadsheetBatch({
          cwd: dir,
          filePath,
          operations: [{ type: "columnWidth", sheetName: "Summary", col: 1, widthPx: null }],
        }),
      ).toEqual({ ok: true });

      expect((await readSheetColumnWidths(dir, filePath, "Summary")).some((w) => w.col === 1)).toBe(
        false,
      );
    });
  });

  test("rejects stale canvas patches when the file changed on disk", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      await fs.writeFile(filePath, await buildWorkbook());
      const before = await fs.stat(filePath);

      await fs.appendFile(filePath, " ");
      const result = await patchSpreadsheetBatch({
        cwd: dir,
        filePath,
        expectedFileVersion: {
          modifiedAtMs: Math.round(before.mtimeMs),
          changeTimeMs: Math.round(before.ctimeMs),
          size: before.size,
          fingerprint: `${Math.round(before.mtimeMs)}:${Math.round(before.ctimeMs)}:${before.size}`,
        },
        operations: [{ type: "cell", sheetName: "Summary", address: "A1", rawInput: "Changed" }],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("write_error");
      expect(result.error.message).toContain("changed on disk");
    });
  });

  test("aborts a batch atomically, leaving the file byte-identical, when an op fails", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      await fs.writeFile(filePath, await buildWorkbook());
      const before = await entryBytes(await fs.readFile(filePath));

      const result = await patchSpreadsheetBatch({
        cwd: dir,
        filePath,
        operations: [
          { type: "cell", sheetName: "Summary", address: "A1", rawInput: "Changed" },
          // Second op has a malformed address, so the whole batch must roll back.
          { type: "cell", sheetName: "Summary", address: "B", rawInput: "boom" },
        ],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("parse_error");
      expect(result.error.message).toContain("Operation 2 failed");

      // Nothing from the partially-applied batch should have touched disk.
      const after = await entryBytes(await fs.readFile(filePath));
      expect([...after.entries()]).toEqual([...before.entries()]);
    });
  });

  test("serializes concurrent batches to the same file so neither edit is lost", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      await fs.writeFile(filePath, await buildWorkbook());

      const [first, second] = await Promise.all([
        patchSpreadsheetBatch({
          cwd: dir,
          filePath,
          operations: [{ type: "cell", sheetName: "Summary", address: "A1", rawInput: "One" }],
        }),
        patchSpreadsheetBatch({
          cwd: dir,
          filePath,
          operations: [{ type: "cell", sheetName: "Summary", address: "B1", rawInput: "Two" }],
        }),
      ]);
      expect(first).toEqual({ ok: true });
      expect(second).toEqual({ ok: true });

      const cells = await readSheetCells(dir, filePath, "Summary");
      expect(cells.find((cell) => cell.address === "A1")?.value).toBe("One");
      expect(cells.find((cell) => cell.address === "B1")?.value).toBe("Two");
    });
  });

  test("treats an empty batch as a no-op without rewriting the file", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      await fs.writeFile(filePath, await buildWorkbook());
      const before = await entryBytes(await fs.readFile(filePath));
      const beforeStat = await fs.stat(filePath);

      const result = await patchSpreadsheetBatch({ cwd: dir, filePath, operations: [] });
      expect(result).toEqual({ ok: true });

      const after = await entryBytes(await fs.readFile(filePath));
      const afterStat = await fs.stat(filePath);
      expect([...after.entries()]).toEqual([...before.entries()]);
      // The file must not be touched at all (same mtime, no re-zip).
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    });
  });

  test("attributes a thrown batch failure to the offending operation index", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      await fs.writeFile(filePath, await buildWorkbook());
      const before = await entryBytes(await fs.readFile(filePath));

      const result = await patchSpreadsheetBatch({
        cwd: dir,
        filePath,
        operations: [
          { type: "cell", sheetName: "Summary", address: "A1", rawInput: "ok" },
          // Invalid color throws inside normalizeColor; the failure must be
          // blamed on operation 2, not operation 1.
          {
            type: "format",
            sheetName: "Summary",
            range: "A1",
            style: { fillColor: "not-a-color" },
          },
        ],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("Operation 2 failed");
      // The aborted batch must leave the file byte-identical.
      const after = await entryBytes(await fs.readFile(filePath));
      expect([...after.entries()]).toEqual([...before.entries()]);
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

  test.each([
    ["semicolon", ";"],
    ["tab", "\t"],
    ["pipe", "|"],
  ])("preserves the preview's %s delimiter when saving", async (_name, delimiter) => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "data.csv");
      await fs.writeFile(filePath, `name${delimiter}amount\nAlice${delimiter}12\n`);
      const before = await readSheetCells(dir, filePath, "CSV");
      expect(before.find((cell) => cell.address === "B2")?.value).toBe("12");

      const rawInput = `99${delimiter}100`;
      expect(await editSpreadsheetCell({ cwd: dir, filePath, address: "B2", rawInput })).toEqual({
        ok: true,
      });
      expect(await fs.readFile(filePath, "utf8")).toBe(
        `name${delimiter}amount\nAlice${delimiter}"${rawInput}"\n`,
      );
      const after = await readSheetCells(dir, filePath, "CSV");
      expect(after.find((cell) => cell.address === "B2")?.value).toBe(rawInput);
    });
  });

  test("preserves an explicit CSV separator preamble without treating it as a data row", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "data.csv");
      await fs.writeFile(filePath, "sep=;\r\nname;amount\r\nAlice;12\r\n");
      expect(
        await editSpreadsheetCell({ cwd: dir, filePath, address: "B2", rawInput: "99" }),
      ).toEqual({ ok: true });
      expect(await fs.readFile(filePath, "utf8")).toBe("sep=;\r\nname;amount\r\nAlice;99\r\n");
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
  test.each([
    ["csv", false],
    ["csv", true],
    ["xlsx", false],
    ["xlsx", true],
  ] as const)(
    "preserves external %s edits during save (expected version: %s)",
    async (ext, withExpectedVersion) => {
      await withTempDir(async (dir) => {
        const filePath = path.join(dir, `race.${ext}`);
        const original = ext === "xlsx" ? await buildWorkbook() : Buffer.from("name,value\na,1\n");
        const external =
          ext === "xlsx"
            ? await buildWorkbook({
                "xl/worksheets/sheet1.xml": WORKBOOK_PARTS["xl/worksheets/sheet1.xml"].replace(
                  "Revenue",
                  "Externally updated revenue",
                ),
              })
            : Buffer.from("name,value\nexternally updated,1\n");
        await fs.writeFile(filePath, original);
        const resolvedPath = await fs.realpath(filePath);
        const expectedFileVersion = spreadsheetFileVersionFromStat(await fs.stat(resolvedPath));
        const tempPrefix = path.join(
          path.dirname(resolvedPath),
          `.${path.basename(resolvedPath)}.`,
        );
        const writeFile = fs.writeFile.bind(fs);
        let injectedExternalWrite = false;
        const writeSpy = spyOn(fs, "writeFile").mockImplementation(
          async (target, data, options) => {
            await writeFile(target, data, options);
            if (typeof target === "string" && target.startsWith(tempPrefix)) {
              injectedExternalWrite = true;
              await writeFile(resolvedPath, external);
            }
          },
        );
        try {
          const result = await patchSpreadsheetBatch({
            cwd: dir,
            filePath,
            ...(withExpectedVersion ? { expectedFileVersion } : {}),
            operations: [{ type: "cell", address: "B2", rawInput: "2" }],
          });
          expect(injectedExternalWrite).toBe(true);
          expect(result).toEqual({
            ok: false,
            error: {
              kind: "write_error",
              message: "Spreadsheet file changed on disk; reload before saving.",
            },
          });
          expect(await fs.readFile(filePath)).toEqual(external);
          expect(await fs.readdir(dir)).toEqual([`race.${ext}`]);
        } finally {
          writeSpy.mockRestore();
        }
      });
    },
  );

  test.each([
    ["row overflow", "A1048577"],
    ["column overflow", "XFE1"],
    ["non-finite row", `A${"9".repeat(309)}`],
    ["non-finite column", `${"Z".repeat(309)}1`],
  ])("rejects %s before allocating cells", (_name, address) => {
    expect(parseAddress(address)).toBeNull();
    expect(parseRange(`A1:${address}`)).toBeNull();
  });

  test("accepts the spreadsheet grid boundary", () => {
    expect(parseAddress("XFD1048576")).toEqual({ row: 1_048_575, col: 16_383 });
  });

  test("rejects out-of-grid column width edits without rewriting the workbook", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "data.xlsx");
      const original = await buildWorkbook();
      await fs.writeFile(filePath, original);
      for (const col of [-1, 0.5, 16_384, Infinity]) {
        const result = await patchSpreadsheetBatch({
          cwd: dir,
          filePath,
          operations: [{ type: "columnWidth", col, widthPx: 100 }],
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.kind).toBe("parse_error");
        expect(await fs.readFile(filePath)).toEqual(original);
      }
    });
  });

  test("bounds cumulative CSV row and cell expansion without persisting a partial batch", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "data.csv");
      const original = "a,b\n";
      for (const addresses of [["A60001"], ["XFD1", "XFD2", "XFD3", "XFD4"]]) {
        await fs.writeFile(filePath, original);
        const result = await patchSpreadsheetBatch({
          cwd: dir,
          filePath,
          operations: addresses.map((address) => ({ type: "cell", address, rawInput: "x" })),
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.kind).toBe("parse_error");
        expect(await fs.readFile(filePath, "utf8")).toBe(original);
      }
    });
  });

  test("accepts canvas-sized batches above the legacy 2,000 operation limit", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "data.csv");
      await fs.writeFile(filePath, "value\n", "utf8");

      const result = await patchSpreadsheetBatch({
        cwd: dir,
        filePath,
        operations: Array.from({ length: 2_025 }, (_, index) => ({
          type: "cell",
          address: "A1",
          rawInput: String(index),
        })),
      });

      expect(result).toEqual({ ok: true });
      expect(await fs.readFile(filePath, "utf8")).toBe("2024\n");
    });
  });

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
