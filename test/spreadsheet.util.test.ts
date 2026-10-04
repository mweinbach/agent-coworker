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
    for (const [file, expected] of [
      ["report.CSV", "csv"],
      ["/tmp/nested.file.csv", "csv"],
      ["Book.Xlsx", "xlsx"],
      ["ledger.xls", null],
      ["notes.ods", null],
      ["no-extension", null],
    ] as const) {
      expect(spreadsheetKindForPath(file)).toBe(expected);
    }
  });
});

describe("readCsvDialect", () => {
  test("honors a sep= preamble, ignores quoted delimiters, and counts the first 1024 chars", () => {
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
    expect(readCsvDialect("a\tb\tc\n1\t2\t3\n")).toMatchObject({ delimiter: "\t", preamble: "" });
    expect(readCsvDialect(`${"a,b\n".repeat(200)}${"x\ty\n".repeat(400)}`)).toMatchObject({
      delimiter: ",",
      preamble: "",
    });
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
