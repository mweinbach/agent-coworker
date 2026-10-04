import { describe, expect, test } from "bun:test";

import { jsonRpcWorkspaceRequestSchemas } from "../src/server/jsonrpc/schema.workspace";
import { CANVAS_DOCUMENT_MAX_BYTES } from "../src/shared/canvasDocument";

const documentOpen = jsonRpcWorkspaceRequestSchemas["cowork/workspace/document/open"];
const documentSave = jsonRpcWorkspaceRequestSchemas["cowork/workspace/document/save"];
const documentSaveAs = jsonRpcWorkspaceRequestSchemas["cowork/workspace/document/saveAs"];
const spreadsheetPatch = jsonRpcWorkspaceRequestSchemas["cowork/workspace/spreadsheet/patch"];
const presentationPreview = jsonRpcWorkspaceRequestSchemas["cowork/workspace/presentation/preview"];

function rejects(schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false);
}

describe("workspace file-op request schemas", () => {
  test("document open/save reject oversize payloads and invalid generations", () => {
    rejects(documentOpen, {
      path: "/notes.md",
      documentId: "d1",
      generation: 0,
      maxBytes: CANVAS_DOCUMENT_MAX_BYTES + 1,
    });
    rejects(documentOpen, {
      path: "/notes.md",
      documentId: "d1",
      generation: 0,
      maxBytes: 0,
    });
    rejects(documentOpen, {
      path: "/notes.md",
      documentId: "d1",
      generation: 1.5,
    });
    rejects(documentSave, {
      documentId: "d1",
      generation: 0,
      editRevision: 0,
      content: "x".repeat(CANVAS_DOCUMENT_MAX_BYTES + 1),
    });
    rejects(documentSaveAs, {
      documentId: "d1",
      generation: 0,
      editRevision: 0,
      content: "ok",
      path: " ",
    });
    rejects(documentSave, {
      documentId: "d1",
      generation: 0,
      editRevision: 0,
      content: "ok",
      extra: true,
    });

    expect(
      documentOpen.parse({
        path: " /notes.md ",
        documentId: " d1 ",
        generation: 0,
        maxBytes: CANVAS_DOCUMENT_MAX_BYTES,
      }),
    ).toEqual({
      path: "/notes.md",
      documentId: "d1",
      generation: 0,
      maxBytes: CANVAS_DOCUMENT_MAX_BYTES,
    });
  });

  test("spreadsheet/patch rejects empty style patches, unknown ops, and oversized batches", () => {
    rejects(spreadsheetPatch, {
      path: "sheet.csv",
      operations: [{ type: "format", range: "A1", style: {} }],
    });
    rejects(spreadsheetPatch, {
      path: "sheet.csv",
      operations: [{ type: "bogus", address: "A1", rawInput: "1" }],
    });
    rejects(spreadsheetPatch, {
      path: "sheet.csv",
      operations: Array.from({ length: 50_001 }, () => ({
        type: "cell" as const,
        address: "A1",
        rawInput: "1",
      })),
    });
    rejects(spreadsheetPatch, { path: "sheet.csv" });
    rejects(presentationPreview, { cwd: "/workspace" });

    expect(
      spreadsheetPatch.parse({
        path: " sheet.csv ",
        operations: [{ type: "columnWidth", col: 0, widthPx: null }],
      }),
    ).toEqual({
      path: "sheet.csv",
      operations: [{ type: "columnWidth", col: 0, widthPx: null }],
    });
    expect(
      spreadsheetPatch.parse({
        path: "sheet.csv",
        operations: [{ type: "format", range: " A1 ", style: { bold: true } }],
      }),
    ).toEqual({
      path: "sheet.csv",
      operations: [{ type: "format", range: "A1", style: { bold: true } }],
    });
  });
});
