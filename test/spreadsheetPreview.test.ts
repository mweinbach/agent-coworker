import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import * as XLSX from "xlsx";

import {
  readSpreadsheetFileVersion,
  readSpreadsheetWorkbookSnapshot,
} from "../src/server/spreadsheetPreview";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-spreadsheet-preview-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const WORKBOOK_OBJECT_PARTS: Record<string, string> = {
  "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`,
  "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FF174A2A"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFE08A"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:B3"/><sheetData><row r="1"><c r="A1" s="1" t="inlineStr"><is><t>Metric</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Revenue</t></is></c><c r="B2"><v>125</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Cost</t></is></c><c r="B3"><v>50</v></c></row></sheetData><drawing r:id="rId2"/><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>`,
  "xl/worksheets/_rels/sheet1.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
  "xl/tables/table1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="RevenueTable" displayName="RevenueTable" ref="A1:B3" totalsRowShown="0"><autoFilter ref="A1:B3"/><tableColumns count="2"><tableColumn id="1" name="Metric"/><tableColumn id="2" name="Value"/></tableColumns></table>`,
  "xl/drawings/drawing1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`,
  "xl/drawings/_rels/drawing1.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>`,
  "xl/charts/chart1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Revenue by Quarter</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:barDir val="col"/></c:barChart></c:plotArea></c:chart></c:chartSpace>`,
};

async function buildObjectWorkbook(): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(WORKBOOK_OBJECT_PARTS)) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("spreadsheet preview parser", () => {
  test("builds a full CSV workbook snapshot with quoted commas, newlines, and empty cells", async () => {
    await withTempDir(async (dir) => {
      const rows = [
        "name,note,amount",
        '"Alice","quoted, comma",10',
        '"Bob","line one\nline two",',
      ];
      for (let i = 0; i < 220; i++) {
        rows.push(`Row ${i},note ${i},${i}`);
      }
      const filePath = path.join(dir, "data.csv");
      await fs.writeFile(filePath, `${rows.join("\n")}\n`, "utf8");

      const result = await readSpreadsheetWorkbookSnapshot({
        cwd: dir,
        filePath,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.workbook.kind).toBe("csv");
      const [sheet] = result.workbook.sheets;
      expect(sheet).toMatchObject({ name: "CSV", rowCount: 223, colCount: 3 });
      expect(sheet?.cells.find((cell) => cell.address === "A2")?.value).toBe("Alice");
      expect(sheet?.cells.find((cell) => cell.address === "B2")?.value).toBe("quoted, comma");
      expect(sheet?.cells.find((cell) => cell.address === "B3")?.value).toBe("line one\nline two");
      expect(sheet?.cells.find((cell) => cell.address === "C3")).toBeUndefined();
    });
  });

  test("keeps CSV cell values as text", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "text-values.csv");
      await fs.writeFile(filePath, "code,date,flag\n001,1/2/2020,TRUE\n", "utf8");

      const result = await readSpreadsheetWorkbookSnapshot({ cwd: dir, filePath });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const sheet = result.workbook.sheets[0];
      expect(sheet?.cells.find((cell) => cell.address === "A2")?.rawValue).toBe("001");
      expect(sheet?.cells.find((cell) => cell.address === "B2")?.rawValue).toBe("1/2/2020");
      expect(sheet?.cells.find((cell) => cell.address === "C2")?.rawValue).toBe("TRUE");
    });
  });

  test("builds a full XLSX workbook snapshot with formulas, merged cells, widths, and number formats", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "model.xlsx");
      const workbook = XLSX.utils.book_new();
      const summary = XLSX.utils.aoa_to_sheet([
        ["Metric", "Value", "Double"],
        ["Revenue", 12.5, { f: "B2*2", v: 25, t: "n" }],
        [],
        ["Merged heading", null, "Tail"],
      ]);
      summary["!merges"] = [XLSX.utils.decode_range("A4:B4")];
      summary["!cols"] = [{ wch: 18 }, { wch: 12 }, { wch: 10 }];
      if (summary.B2) summary.B2.z = "$0.00";
      XLSX.utils.book_append_sheet(workbook, summary, "Summary");
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["id"], [1]]), "Data");
      const xlsxBytes = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
      await fs.writeFile(filePath, xlsxBytes);

      const result = await readSpreadsheetWorkbookSnapshot({
        cwd: dir,
        filePath,
        sheetName: "Summary",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.workbook.kind).toBe("xlsx");
      expect(result.workbook.sheets.map((sheet) => sheet.name)).toEqual(["Summary", "Data"]);
      expect(result.workbook.activeSheetName).toBe("Summary");
      const summarySheet = result.workbook.sheets[0];
      expect(summarySheet?.cells.find((cell) => cell.address === "C2")?.formula).toBe("B2*2");
      expect(summarySheet?.cells.find((cell) => cell.address === "B2")?.style?.numberFormat).toBe(
        "$0.00",
      );
      expect(summarySheet?.cells.find((cell) => cell.address === "B4")).toBeUndefined();
      expect(summarySheet?.mergedCells).toEqual([
        { ref: "A4:B4", startRow: 3, startCol: 0, endRow: 3, endCol: 1 },
      ]);
      expect(summarySheet?.columnWidths[0]?.widthChars).toBe(18);
    });
  });

  test("keeps formatted XLSX dates as numeric date values for Univer", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "dates.xlsx");
      const workbook = XLSX.utils.book_new();
      const sheet = XLSX.utils.aoa_to_sheet([["Date"], [new Date(Date.UTC(2024, 0, 15))]], {
        cellDates: true,
      });
      if (sheet.A2) sheet.A2.z = "m/d/yy";
      XLSX.utils.book_append_sheet(workbook, sheet, "Dates");
      await fs.writeFile(filePath, XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));

      const result = await readSpreadsheetWorkbookSnapshot({ cwd: dir, filePath });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const dateCell = result.workbook.sheets[0]?.cells.find((cell) => cell.address === "A2");
      expect(typeof dateCell?.rawValue).toBe("number");
      expect(dateCell?.style?.numberFormat).toBe("m/d/yy");
    });
  });

  test("serializes XLSX dates using the workbook 1904 date system", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "dates-1904.xlsx");
      const workbook = XLSX.utils.book_new();
      workbook.Workbook = { WBProps: { date1904: true } };
      const sheet = XLSX.utils.aoa_to_sheet([["Date"], [new Date(Date.UTC(2024, 0, 15))]], {
        cellDates: true,
      });
      if (sheet.A2) sheet.A2.z = "m/d/yy";
      XLSX.utils.book_append_sheet(workbook, sheet, "Dates");
      await fs.writeFile(filePath, XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));

      const result = await readSpreadsheetWorkbookSnapshot({ cwd: dir, filePath });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const dateCell = result.workbook.sheets[0]?.cells.find((cell) => cell.address === "A2");
      expect(dateCell?.rawValue).toBe(43844);
      expect(dateCell?.style?.numberFormat).toBe("m/d/yy");
    });
  });

  test("builds a full workbook snapshot for Univer without viewport truncation", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "objects.xlsx");
      await fs.writeFile(filePath, await buildObjectWorkbook());

      const result = await readSpreadsheetWorkbookSnapshot({
        cwd: dir,
        filePath,
        sheetName: "Summary",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.workbook.kind).toBe("xlsx");
      expect(result.workbook.activeSheetName).toBe("Summary");
      expect(result.workbook.fileVersion).toMatchObject({
        size: expect.any(Number),
        fingerprint: expect.any(String),
      });
      expect(result.workbook.sheets).toHaveLength(1);
      const [sheet] = result.workbook.sheets;
      expect(sheet).toMatchObject({
        id: "sheet-1",
        name: "Summary",
        rowCount: 3,
        colCount: 2,
        loadedRowCount: 3,
        loadedColCount: 2,
        truncatedRows: false,
        truncatedCols: false,
      });
      expect(sheet.cells.map((cell) => cell.address)).toEqual(["A1", "B1", "A2", "B2", "A3", "B3"]);
      expect(sheet.cells.find((cell) => cell.address === "A1")?.style).toMatchObject({
        bold: true,
        fillColor: "#FFE08A",
        textColor: "#174A2A",
      });
      expect(sheet.tables).toEqual([
        {
          name: "RevenueTable",
          ref: "A1:B3",
          startRow: 0,
          startCol: 0,
          endRow: 2,
          endCol: 1,
        },
      ]);
      expect(sheet.charts).toEqual([
        {
          id: "chart1",
          title: "Revenue by Quarter",
          type: "bar",
          anchor: {
            fromRow: 0,
            fromCol: 3,
            toRow: 12,
            toCol: 8,
          },
        },
      ]);
    });
  });

  test("caps workbook snapshots before serializing oversized sheets", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "large.csv");
      const header = Array.from({ length: 250 }, (_, index) => `col${index + 1}`).join(",");
      const row = Array.from({ length: 250 }, (_, index) => String(index + 1)).join(",");
      await fs.writeFile(
        filePath,
        `${header}\n${Array.from({ length: 300 }, () => row).join("\n")}\n`,
      );

      const result = await readSpreadsheetWorkbookSnapshot({ cwd: dir, filePath });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const sheet = result.workbook.sheets[0];
      expect(sheet?.rowCount).toBe(301);
      expect(sheet?.colCount).toBe(250);
      expect(sheet?.loadedRowCount).toBe(250);
      expect(sheet?.loadedColCount).toBe(200);
      expect(sheet?.truncatedRows).toBe(true);
      expect(sheet?.truncatedCols).toBe(true);
      expect(sheet?.cells.length).toBeLessThanOrEqual(50_000);
      expect(sheet?.cells.some((cell) => cell.col >= 200)).toBe(false);
      expect(result.workbook.warnings[0]).toContain("workbook canvas snapshot is limited");
    });
  });

  test("returns a lightweight file version fingerprint for auto-refresh checks", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "data.csv");
      await fs.writeFile(filePath, "name,value\nAlpha,1\n", "utf8");

      const initial = await readSpreadsheetFileVersion({ cwd: dir, filePath });
      expect(initial.ok).toBe(true);
      if (!initial.ok) return;
      expect(initial.version.size).toBeGreaterThan(0);
      expect(initial.version.fingerprint).toContain(":");

      await new Promise((resolve) => setTimeout(resolve, 5));
      await fs.appendFile(filePath, "Beta,2\n", "utf8");
      const updated = await readSpreadsheetFileVersion({ cwd: dir, filePath });
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect(updated.version.fingerprint).not.toBe(initial.version.fingerprint);
    });
  });

  test("returns structured parse errors for invalid spreadsheet payloads", async () => {
    await withTempDir(async (dir) => {
      const csvPath = path.join(dir, "bad.csv");
      await fs.writeFile(csvPath, 'name,note\nAlice,"unterminated\n', "utf8");
      const csvResult = await readSpreadsheetWorkbookSnapshot({ cwd: dir, filePath: csvPath });
      expect(csvResult.ok).toBe(false);
      if (!csvResult.ok) {
        expect(csvResult.error.kind).toBe("parse_error");
        expect(csvResult.error.message).toContain("unterminated quoted field");
      }

      const xlsxPath = path.join(dir, "bad.xlsx");
      await fs.writeFile(xlsxPath, "not a zip", "utf8");
      const xlsxResult = await readSpreadsheetWorkbookSnapshot({ cwd: dir, filePath: xlsxPath });
      expect(xlsxResult.ok).toBe(false);
      if (!xlsxResult.ok) {
        expect(xlsxResult.error.kind).toBe("parse_error");
      }
    });
  });

  test("rejects paths outside the workspace root, including symlink escapes", async () => {
    await withTempDir(async (dir) => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-spreadsheet-outside-"));
      try {
        const outsideFile = path.join(outside, "data.csv");
        await fs.writeFile(outsideFile, "a,b\n1,2\n", "utf8");
        const outsideResult = await readSpreadsheetWorkbookSnapshot({
          cwd: dir,
          filePath: outsideFile,
        });
        expect(outsideResult.ok).toBe(false);
        if (!outsideResult.ok) expect(outsideResult.error.kind).toBe("outside_workspace");

        const linkPath = path.join(dir, "linked.csv");
        try {
          await fs.symlink(outsideFile, linkPath);
        } catch {
          return;
        }
        const symlinkResult = await readSpreadsheetWorkbookSnapshot({
          cwd: dir,
          filePath: linkPath,
        });
        expect(symlinkResult.ok).toBe(false);
        if (!symlinkResult.ok) expect(symlinkResult.error.kind).toBe("outside_workspace");
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });
});
