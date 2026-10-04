import { describe, expect, test } from "bun:test";
import { jsonRpcWorkspaceRequestSchemas } from "../src/server/jsonrpc/schema.workspace";
import { CANVAS_DOCUMENT_MAX_BYTES } from "../src/shared/canvasDocument";

const s = jsonRpcWorkspaceRequestSchemas;
const rejectsAll = (
  schema: { safeParse: (v: unknown) => { success: boolean } },
  cases: unknown[],
) => {
  for (const value of cases) expect(schema.safeParse(value).success).toBe(false);
};

describe("workspace file-op request schemas", () => {
  test("document open/save reject oversize payloads and invalid generations", () => {
    rejectsAll(s["cowork/workspace/document/open"], [
      {
        path: "/notes.md",
        documentId: "d1",
        generation: 0,
        maxBytes: CANVAS_DOCUMENT_MAX_BYTES + 1,
      },
      { path: "/notes.md", documentId: "d1", generation: 0, maxBytes: 0 },
      { path: "/notes.md", documentId: "d1", generation: 1.5 },
    ]);
    rejectsAll(s["cowork/workspace/document/save"], [
      {
        documentId: "d1",
        generation: 0,
        editRevision: 0,
        content: "x".repeat(CANVAS_DOCUMENT_MAX_BYTES + 1),
      },
      { documentId: "d1", generation: 0, editRevision: 0, content: "ok", extra: true },
    ]);
    rejectsAll(s["cowork/workspace/document/saveAs"], [
      { documentId: "d1", generation: 0, editRevision: 0, content: "ok", path: " " },
    ]);

    expect(
      s["cowork/workspace/document/open"].parse({
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
    const patch = s["cowork/workspace/spreadsheet/patch"];
    rejectsAll(patch, [
      { path: "sheet.csv", operations: [{ type: "format", range: "A1", style: {} }] },
      { path: "sheet.csv", operations: [{ type: "bogus", address: "A1", rawInput: "1" }] },
      {
        path: "sheet.csv",
        operations: Array.from({ length: 50_001 }, () => ({
          type: "cell" as const,
          address: "A1",
          rawInput: "1",
        })),
      },
      { path: "sheet.csv" },
    ]);
    rejectsAll(s["cowork/workspace/presentation/preview"], [{ cwd: "/workspace" }]);

    expect(
      patch.parse({
        path: " sheet.csv ",
        operations: [{ type: "columnWidth", col: 0, widthPx: null }],
      }),
    ).toEqual({
      path: "sheet.csv",
      operations: [{ type: "columnWidth", col: 0, widthPx: null }],
    });
    expect(
      patch.parse({
        path: "sheet.csv",
        operations: [{ type: "format", range: " A1 ", style: { bold: true } }],
      }),
    ).toEqual({
      path: "sheet.csv",
      operations: [{ type: "format", range: "A1", style: { bold: true } }],
    });
  });
});
