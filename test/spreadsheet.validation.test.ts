import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

import { readXlsxSheetObjects, resolveWorksheetPart } from "../src/server/spreadsheet/ooxml";
import {
  resolveWorkspaceFilePath,
  spreadsheetPathFailure,
  validateXlsxZipSignature,
} from "../src/server/spreadsheet/read";

const OUTSIDE_WORKSPACE_MESSAGE = "Path is outside the workspace root.";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(import.meta.dir, "tmp-spreadsheet-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function zipParts(parts: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(parts)) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

const WORKSHEET_PARTS: Record<string, string> = {
  "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Data" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
  "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData><row r="1"><c r="A1" s="1" t="inlineStr"><is><t>Metric</t></is></c></row></sheetData><drawing r:id="rId2"/><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>`,
  "xl/worksheets/sheet2.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`,
  "xl/worksheets/_rels/sheet1.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
  "xl/tables/table1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="RevenueTable" displayName="RevenueTable" ref="A1:B3"><tableColumns count="1"><tableColumn id="1" name="Metric"/></tableColumns></table>`,
  "xl/drawings/drawing1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`,
  "xl/drawings/_rels/drawing1.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>`,
  "xl/charts/chart1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Revenue</a:t></a:r></a:p></c:rich></c:tx></c:title></c:chart></c:chartSpace>`,
  "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FF174A2A"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFE08A"/></patternFill></fill></fills><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0"/><xf numFmtId="0" fontId="1" fillId="2" applyFont="1" applyFill="1"/></cellXfs></styleSheet>`,
};

describe("validateXlsxZipSignature", () => {
  test("accepts a PK zip header and rejects short or non-zip bytes", () => {
    expect(() => validateXlsxZipSignature(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).not.toThrow();
    expect(() => validateXlsxZipSignature(Buffer.from([0x50, 0x4b]))).toThrow(
      "XLSX file is not a valid Office Open XML zip package.",
    );
    expect(() => validateXlsxZipSignature(Buffer.from([0x00, 0x00, 0x00, 0x00]))).toThrow(
      "XLSX file is not a valid Office Open XML zip package.",
    );
  });
});

describe("spreadsheetPathFailure", () => {
  test("maps ENOENT, outside-workspace, and other errors fail-closed", () => {
    expect(spreadsheetPathFailure(Object.assign(new Error("missing"), { code: "ENOENT" }))).toEqual(
      {
        kind: "not_found",
        message: "Spreadsheet file was not found.",
      },
    );
    expect(spreadsheetPathFailure(new Error(OUTSIDE_WORKSPACE_MESSAGE))).toEqual({
      kind: "outside_workspace",
      message: OUTSIDE_WORKSPACE_MESSAGE,
    });
    expect(spreadsheetPathFailure("boom")).toEqual({
      kind: "not_found",
      message: "boom",
    });
  });
});

describe("resolveWorkspaceFilePath", () => {
  test("resolves files inside the workspace and rejects escapes", async () => {
    await withTempDir(async (workspace) => {
      const inside = path.join(workspace, "book.xlsx");
      await fs.writeFile(inside, "pk", "utf8");
      expect(await resolveWorkspaceFilePath(workspace, "book.xlsx")).toBe(
        await fs.realpath(inside),
      );

      const outsideDir = await fs.mkdtemp(path.join(import.meta.dir, "tmp-outside-"));
      try {
        const outsideFile = path.join(outsideDir, "secret.xlsx");
        await fs.writeFile(outsideFile, "secret", "utf8");
        await expect(resolveWorkspaceFilePath(workspace, outsideFile)).rejects.toThrow(
          OUTSIDE_WORKSPACE_MESSAGE,
        );
        await expect(resolveWorkspaceFilePath(workspace, "../secret.xlsx")).rejects.toThrow();

        const link = path.join(workspace, "escape.xlsx");
        await fs.symlink(outsideFile, link);
        await expect(resolveWorkspaceFilePath(workspace, "escape.xlsx")).rejects.toThrow(
          OUTSIDE_WORKSPACE_MESSAGE,
        );
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });
});

describe("resolveWorksheetPart", () => {
  test("selects the first sheet, a named sheet, and absolute relationship targets", async () => {
    const zip = await JSZip.loadAsync(await zipParts(WORKSHEET_PARTS));
    expect(await resolveWorksheetPart(zip)).toBe("xl/worksheets/sheet1.xml");
    expect(await resolveWorksheetPart(zip, "Data")).toBe("xl/worksheets/sheet2.xml");
    expect(await resolveWorksheetPart(zip, "Missing")).toBeNull();
  });

  test("returns null when workbook, sheets, or relationships are missing", async () => {
    expect(await resolveWorksheetPart(await JSZip.loadAsync(await zipParts({})))).toBeNull();
    expect(
      await resolveWorksheetPart(
        await JSZip.loadAsync(
          await zipParts({
            "xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>`,
          }),
        ),
      ),
    ).toBeNull();
    expect(
      await resolveWorksheetPart(
        await JSZip.loadAsync(
          await zipParts({
            "xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Summary" sheetId="1" r:id="rId9"/></sheets></workbook>`,
            "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
          }),
        ),
      ),
    ).toBeNull();
  });
});

describe("readXlsxSheetObjects", () => {
  test("returns empty objects when the worksheet cannot be resolved", async () => {
    const objects = await readXlsxSheetObjects(await zipParts({}), "Summary");
    expect(objects.tables).toEqual([]);
    expect(objects.charts).toEqual([]);
    expect(objects.cellStyles.size).toBe(0);
  });

  test("extracts tables, charts, and styled cells for a resolved sheet", async () => {
    const objects = await readXlsxSheetObjects(await zipParts(WORKSHEET_PARTS), "Summary");
    expect(objects.tables).toEqual([
      { name: "RevenueTable", ref: "A1:B3", startRow: 0, startCol: 0, endRow: 2, endCol: 1 },
    ]);
    expect(objects.charts).toEqual([
      {
        id: "chart1",
        title: "Revenue",
        anchor: { fromRow: 0, fromCol: 0, toRow: 1, toCol: 1 },
      },
    ]);
    expect(objects.cellStyles.get("A1")).toEqual({
      bold: true,
      fontSize: 11,
      fillColor: "#FFE08A",
      textColor: "#174A2A",
    });
  });
});
