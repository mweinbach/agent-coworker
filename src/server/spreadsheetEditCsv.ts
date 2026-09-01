import fs from "node:fs/promises";
import type { SpreadsheetBatchPatchOperation } from "../shared/spreadsheetPreview";
import { parseAddress } from "./spreadsheetA1";
import { readCsvDialect } from "./spreadsheetCsv";
import type { OpsOutcome } from "./spreadsheetEditTypes";

const MAX_CSV_EXPANSION_ENTRIES = 50_000;

export async function runCsvOps(
  filePath: string,
  operations: SpreadsheetBatchPatchOperation[],
  writeFileAtomic: (filePath: string, data: Buffer | string) => Promise<void>,
): Promise<OpsOutcome> {
  const raw = (await fs.readFile(filePath)).toString("utf8");
  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const { delimiter, preamble, content: text } = readCsvDialect(raw);
  const eol = text.match(/\r\n|\r|\n/)?.[0] ?? "\n";
  const hasTrailingNewline = /[\r\n]$/.test(text);

  const rows = parseCsv(text, delimiter);
  let expansionEntries = 0;
  for (const [index, op] of operations.entries()) {
    if (op.type === "format" || op.type === "merge" || op.type === "columnWidth") {
      return {
        ok: false,
        index,
        error: {
          kind: "unsupported_format",
          message:
            op.type === "format"
              ? "Formatting supports XLSX files."
              : op.type === "merge"
                ? "Merging supports XLSX files."
                : "Column widths support XLSX files.",
        },
      };
    }
    const addr = parseAddress(op.address);
    if (!addr) {
      return {
        ok: false,
        index,
        error: { kind: "parse_error", message: `Invalid cell address: ${op.address}` },
      };
    }
    expansionEntries +=
      Math.max(0, addr.row + 1 - rows.length) +
      Math.max(0, addr.col + 1 - (rows[addr.row]?.length ?? 0));
    if (expansionEntries > MAX_CSV_EXPANSION_ENTRIES) {
      return {
        ok: false,
        index,
        error: {
          kind: "parse_error",
          message: `CSV edits may add at most ${MAX_CSV_EXPANSION_ENTRIES} rows and cells per batch.`,
        },
      };
    }
    while (rows.length <= addr.row) rows.push([]);
    const row = rows[addr.row] as string[];
    while (row.length <= addr.col) row.push("");
    row[addr.col] = op.rawInput;
  }

  let out = rows
    .map((cells) => cells.map((cell) => csvQuoteField(cell, delimiter)).join(delimiter))
    .join(eol);
  if (hasTrailingNewline) out += eol;
  out = preamble + out;
  if (hasBom) out = `﻿${out}`;

  await writeFileAtomic(filePath, out);
  return { ok: true };
}

/** Quote-aware CSV parse into a 2D array of decoded field values. */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Flush a trailing record only when there is pending content (no phantom row
  // after a terminating newline).
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvQuoteField(value: string, delimiter: string): string {
  if (/["\r\n]/.test(value) || value.includes(delimiter)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
