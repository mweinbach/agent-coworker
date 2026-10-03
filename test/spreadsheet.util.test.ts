import { describe, expect, test } from "bun:test";

import { spreadsheetKindForPath } from "../src/server/spreadsheet/read";
import {
  decodeColumnWidth,
  encodeColumnWidth,
  MAX_COLUMN_WIDTH_PX,
  readCsvDialect,
} from "../src/server/spreadsheet/util";

describe("spreadsheetKindForPath", () => {
  test("classifies csv and xlsx case-insensitively and rejects other extensions", () => {
    expect(spreadsheetKindForPath("report.CSV")).toBe("csv");
    expect(spreadsheetKindForPath("/tmp/nested.file.csv")).toBe("csv");
    expect(spreadsheetKindForPath("Book.Xlsx")).toBe("xlsx");
    expect(spreadsheetKindForPath("ledger.xls")).toBeNull();
    expect(spreadsheetKindForPath("notes.ods")).toBeNull();
    expect(spreadsheetKindForPath("no-extension")).toBeNull();
  });
});

describe("readCsvDialect", () => {
  test("honors a sep= preamble after stripping a BOM", () => {
    expect(readCsvDialect("\uFEFFsep=;\r\nname;amount\r\n")).toEqual({
      delimiter: ";",
      preamble: "sep=;\r\n",
      content: "name;amount\r\n",
    });
    expect(readCsvDialect("sep=|\nname|amount\n")).toEqual({
      delimiter: "|",
      preamble: "sep=|\n",
      content: "name|amount\n",
    });
  });

  test("ignores quoted delimiter characters and defaults to comma", () => {
    expect(readCsvDialect('name,"a,b,c,d,e",note\n')).toMatchObject({
      delimiter: ",",
      preamble: "",
    });
    expect(readCsvDialect("")).toEqual({ delimiter: ",", preamble: "", content: "" });
    expect(readCsvDialect("\uFEFFalone")).toEqual({
      delimiter: ",",
      preamble: "",
      content: "alone",
    });
  });

  test("selects the most frequent unquoted delimiter in the first 1024 characters", () => {
    expect(readCsvDialect("a\tb\tc\n1\t2\t3\n")).toMatchObject({ delimiter: "\t", preamble: "" });
    const prefix = "a,b\n".repeat(200);
    const suffix = `${"x\ty\n".repeat(400)}`;
    expect(readCsvDialect(`${prefix}${suffix}`)).toMatchObject({ delimiter: ",", preamble: "" });
  });
});

describe("spreadsheet column width encoding", () => {
  test("encodes CSS-pixel widths in OOXML units and decodes them back", () => {
    expect(encodeColumnWidth(0)).toBe(0);
    expect(encodeColumnWidth(70)).toBe(10);
    expect(encodeColumnWidth(MAX_COLUMN_WIDTH_PX)).toBe(255);
    expect(decodeColumnWidth(10)).toEqual({ widthPx: 70, widthChars: 9.29 });
    expect(decodeColumnWidth(0).widthPx).toBe(0);
  });
});
