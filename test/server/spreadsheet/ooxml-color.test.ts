import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import {
  asRecord,
  readOoxmlColor,
  resolveWorksheetPart,
  stringValue,
} from "../../../src/server/spreadsheet/ooxml";

async function workbookZip(parts: Record<string, string>): Promise<JSZip> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(parts)) {
    zip.file(name, content);
  }
  return JSZip.loadAsync(await zip.generateAsync({ type: "nodebuffer" }));
}

const TWO_SHEET_PARTS = {
  "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Summary" sheetId="1" r:id="rId1"/>
    <sheet name="Data" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`,
  "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`,
  "xl/worksheets/sheet1.xml": "<worksheet/>",
  "xl/worksheets/sheet2.xml": "<worksheet/>",
};

describe("readOoxmlColor", () => {
  test("normalizes RGB, indexed, and theme colors and fail-closes invalid input", () => {
    expect(readOoxmlColor({ rgb: "FF001122" })).toBe("#001122");
    expect(readOoxmlColor({ rgb: "00abCd" })).toBe("#00ABCD");
    expect(readOoxmlColor({ rgb: "ZZZZZZ" })).toBeNull();
    expect(readOoxmlColor({ rgb: "1122" })).toBeNull();
    expect(readOoxmlColor({ indexed: 2 })).toBe("#FF0000");
    expect(readOoxmlColor({ indexed: "4" })).toBe("#0000FF");
    expect(readOoxmlColor({ indexed: 99 })).toBeNull();
    expect(readOoxmlColor({ theme: 1 })).toBe("#000000");
    expect(readOoxmlColor({ theme: 0, tint: -0.5 })).toBe("#808080");
    expect(readOoxmlColor({ theme: 1, tint: 0.5 })).toBe("#808080");
    expect(readOoxmlColor({ theme: 99 })).toBeNull();
    expect(readOoxmlColor(null)).toBeNull();
    expect(readOoxmlColor("FF0000")).toBeNull();
  });

  test("prefers RGB over indexed or theme when both are present", () => {
    expect(readOoxmlColor({ rgb: "00FF00", indexed: 2, theme: 4 })).toBe("#00FF00");
  });
});

describe("ooxml value helpers", () => {
  test("asRecord and stringValue fail closed on non-objects and non-scalars", () => {
    expect(asRecord({ name: "Summary" })).toEqual({ name: "Summary" });
    expect(asRecord(null)).toBeNull();
    expect(asRecord("sheet")).toBeNull();
    expect(stringValue("Data")).toBe("Data");
    expect(stringValue(12)).toBe("12");
    expect(stringValue(true)).toBe("true");
    expect(stringValue({ name: "Data" })).toBeUndefined();
    expect(stringValue(undefined)).toBeUndefined();
  });
});

describe("resolveWorksheetPart", () => {
  test("selects the named sheet, falls back to the first sheet, and returns null for unknown names", async () => {
    const zip = await workbookZip(TWO_SHEET_PARTS);
    expect(await resolveWorksheetPart(zip, "Data")).toBe("xl/worksheets/sheet2.xml");
    expect(await resolveWorksheetPart(zip, "Summary")).toBe("xl/worksheets/sheet1.xml");
    expect(await resolveWorksheetPart(zip)).toBe("xl/worksheets/sheet1.xml");
    expect(await resolveWorksheetPart(zip, "Missing")).toBeNull();
  });

  test("returns null when workbook.xml or sheet relationships are missing", async () => {
    const empty = await workbookZip({});
    expect(await resolveWorksheetPart(empty, "Summary")).toBeNull();

    const missingRels = await workbookZip({
      "xl/workbook.xml": TWO_SHEET_PARTS["xl/workbook.xml"],
    });
    expect(await resolveWorksheetPart(missingRels, "Summary")).toBeNull();
  });
});
