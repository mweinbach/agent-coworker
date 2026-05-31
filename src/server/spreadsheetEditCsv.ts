import fs from "node:fs/promises";
import type { SpreadsheetBatchPatchOperation } from "../shared/spreadsheetPreview";
import { parseAddress } from "./spreadsheetA1";
import type { OpsOutcome } from "./spreadsheetEditTypes";

export async function runCsvOps(
  filePath: string,
  operations: SpreadsheetBatchPatchOperation[],
  writeFileAtomic: (filePath: string, data: Buffer | string) => Promise<void>,
): Promise<OpsOutcome> {
  const raw = (await fs.readFile(filePath)).toString("utf8");
  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const text = hasBom ? raw.slice(1) : raw;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = /\r?\n$/.test(text);

  const rows = parseCsv(text);
  for (const [index, op] of operations.entries()) {
    if (op.type === "format") {
      return {
        ok: false,
        index,
        error: { kind: "unsupported_format", message: "Formatting supports XLSX files." },
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
    while (rows.length <= addr.row) rows.push([]);
    const row = rows[addr.row] as string[];
    while (row.length <= addr.col) row.push("");
    row[addr.col] = op.rawInput;
  }

  let out = rows.map((cells) => cells.map(csvQuoteField).join(",")).join(eol);
  if (hasTrailingNewline) out += eol;
  if (hasBom) out = `﻿${out}`;

  await writeFileAtomic(filePath, out);
  return { ok: true };
}

/** Quote-aware CSV parse into a 2D array of decoded field values. */
function parseCsv(text: string): string[][] {
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
    if (ch === ",") {
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

function csvQuoteField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
