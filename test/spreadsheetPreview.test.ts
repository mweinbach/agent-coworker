import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";

import { previewSpreadsheetFile } from "../src/server/spreadsheetPreview";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-spreadsheet-preview-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("spreadsheet preview parser", () => {
  test("parses CSV with quoted commas, newlines, empty cells, and viewport truncation", async () => {
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

      const result = await previewSpreadsheetFile({
        cwd: dir,
        filePath,
        viewport: { startRow: 1, rowCount: 2, colCount: 3 },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.preview.kind).toBe("csv");
      expect(result.preview.sheets).toEqual([{ name: "CSV", rowCount: 223, colCount: 3 }]);
      expect(result.preview.viewport.truncatedRows).toBe(true);
      expect(result.preview.cells[0]?.[0]?.value).toBe("Alice");
      expect(result.preview.cells[0]?.[1]?.value).toBe("quoted, comma");
      expect(result.preview.cells[1]?.[1]?.value).toBe("line one\nline two");
      expect(result.preview.cells[1]?.[2]?.value).toBe("");
    });
  });

  test("parses XLSX sheets, formulas, merged cells, widths, and number formats", async () => {
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

      const result = await previewSpreadsheetFile({
        cwd: dir,
        filePath,
        sheetName: "Summary",
        viewport: { rowCount: 10, colCount: 4 },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.preview.kind).toBe("xlsx");
      expect(result.preview.sheets.map((sheet) => sheet.name)).toEqual(["Summary", "Data"]);
      expect(result.preview.selectedSheetName).toBe("Summary");
      expect(result.preview.cells[1]?.[2]?.formula).toBe("B2*2");
      expect(result.preview.cells[1]?.[1]?.style?.numberFormat).toBe("$0.00");
      expect(result.preview.cells[3]?.[1]?.value).toBe("");
      expect(result.preview.mergedCells).toEqual([
        { ref: "A4:B4", startRow: 3, startCol: 0, endRow: 3, endCol: 1 },
      ]);
      expect(result.preview.columnWidths[0]?.widthChars).toBe(18);
    });
  });

  test("returns structured parse errors for invalid spreadsheet payloads", async () => {
    await withTempDir(async (dir) => {
      const csvPath = path.join(dir, "bad.csv");
      await fs.writeFile(csvPath, 'name,note\nAlice,"unterminated\n', "utf8");
      const csvResult = await previewSpreadsheetFile({ cwd: dir, filePath: csvPath });
      expect(csvResult.ok).toBe(false);
      if (!csvResult.ok) {
        expect(csvResult.error.kind).toBe("parse_error");
        expect(csvResult.error.message).toContain("unterminated quoted field");
      }

      const xlsxPath = path.join(dir, "bad.xlsx");
      await fs.writeFile(xlsxPath, "not a zip", "utf8");
      const xlsxResult = await previewSpreadsheetFile({ cwd: dir, filePath: xlsxPath });
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
        await expect(previewSpreadsheetFile({ cwd: dir, filePath: outsideFile })).rejects.toThrow(
          /outside the workspace root/,
        );

        const linkPath = path.join(dir, "linked.csv");
        try {
          await fs.symlink(outsideFile, linkPath);
        } catch {
          return;
        }
        await expect(previewSpreadsheetFile({ cwd: dir, filePath: linkPath })).rejects.toThrow(
          /outside the workspace root/,
        );
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });
});
