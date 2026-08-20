import { describe, expect, test } from "bun:test";
import { jsonRpcRequestSchemas } from "../src/server/jsonrpc/schema";
import { CANVAS_DOCUMENT_MAX_BYTES } from "../src/shared/canvasDocument";

const fileVersion = {
  modifiedAtMs: 1,
  changeTimeMs: 1,
  size: 12,
  fingerprint: "fp-1",
};

describe("workspace document and spreadsheet request schemas", () => {
  test("document/open rejects blank ids, negative generation, oversized maxBytes, and extras", () => {
    const schema = jsonRpcRequestSchemas["cowork/workspace/document/open"];
    expect(
      schema.safeParse({
        path: "notes.md",
        documentId: "doc-1",
        generation: 0,
        maxBytes: 1024,
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ path: "   ", documentId: "doc-1", generation: 0 }).success).toBe(
      false,
    );
    expect(schema.safeParse({ path: "notes.md", documentId: "  ", generation: 0 }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ path: "notes.md", documentId: "doc-1", generation: -1 }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        path: "notes.md",
        documentId: "doc-1",
        generation: 0,
        maxBytes: CANVAS_DOCUMENT_MAX_BYTES + 1,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        path: "notes.md",
        documentId: "doc-1",
        generation: 0,
        extra: true,
      }).success,
    ).toBe(false);
  });

  test("document/save and saveAs reject oversized content and missing edit revision", () => {
    const save = jsonRpcRequestSchemas["cowork/workspace/document/save"];
    const saveAs = jsonRpcRequestSchemas["cowork/workspace/document/saveAs"];
    const content = "ok";
    expect(
      save.safeParse({
        documentId: "doc-1",
        generation: 1,
        editRevision: 0,
        content,
      }).success,
    ).toBe(true);
    expect(
      save.safeParse({
        documentId: "doc-1",
        generation: 1,
        content,
      }).success,
    ).toBe(false);
    expect(
      save.safeParse({
        documentId: "doc-1",
        generation: 1,
        editRevision: 0,
        content: "x".repeat(CANVAS_DOCUMENT_MAX_BYTES + 1),
      }).success,
    ).toBe(false);
    expect(
      saveAs.safeParse({
        documentId: "doc-1",
        generation: 1,
        editRevision: 0,
        content,
        path: "   ",
      }).success,
    ).toBe(false);
  });

  test("spreadsheet/patch rejects empty format styles, extra fields, and invalid widths", () => {
    const schema = jsonRpcRequestSchemas["cowork/workspace/spreadsheet/patch"];
    expect(
      schema.safeParse({
        path: "sheet.xlsx",
        operations: [
          { type: "cell", address: "A1", rawInput: "1" },
          { type: "format", range: "A1:B2", style: { bold: true } },
        ],
        expectedFileVersion: fileVersion,
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        path: "sheet.xlsx",
        operations: [{ type: "format", range: "A1", style: {} }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        path: "sheet.xlsx",
        operations: [{ type: "columnWidth", col: 0, widthPx: 0 }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        path: "sheet.xlsx",
        operations: [{ type: "cell", address: "A1", rawInput: "1", extra: true }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        path: "   ",
        operations: [],
      }).success,
    ).toBe(false);
  });
});
