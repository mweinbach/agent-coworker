import { describe, expect, test } from "bun:test";

import {
  jsonRpcWorkspaceNotificationSchemas,
  jsonRpcWorkspaceResultSchemas,
} from "../src/server/jsonrpc/schema.workspace";

const fileChanged = jsonRpcWorkspaceNotificationSchemas["cowork/workspace/fileChanged"];
const version = {
  modifiedAtMs: 1,
  changeTimeMs: 1,
  size: 12,
  fingerprint: "fp-1",
};

describe("workspace result and fileChanged schemas", () => {
  test("fileChanged accepts changed/deleted shapes and rejects extras or invalid versions", () => {
    expect(
      fileChanged.parse({
        cwd: " /tmp/ws ",
        kind: "changed",
        path: " notes.md ",
        version,
      }),
    ).toEqual({
      cwd: "/tmp/ws",
      kind: "changed",
      path: "notes.md",
      version,
    });
    expect(
      fileChanged.parse({
        cwd: "/tmp/ws",
        kind: "deleted",
        path: "notes.md",
        version: null,
      }),
    ).toEqual({
      cwd: "/tmp/ws",
      kind: "deleted",
      path: "notes.md",
      version: null,
    });
    expect(
      fileChanged.safeParse({
        cwd: "/tmp/ws",
        kind: "changed",
        path: "notes.md",
        version: { ...version, extra: true },
      }).success,
    ).toBe(false);
    expect(
      fileChanged.safeParse({
        cwd: "/tmp/ws",
        kind: "changed",
        path: "notes.md",
        version: { ...version, size: -1 },
      }).success,
    ).toBe(false);
    expect(
      fileChanged.safeParse({
        cwd: "/tmp/ws",
        kind: "changed",
        path: "notes.md",
        version: { ...version, fingerprint: "   " },
      }).success,
    ).toBe(false);
    expect(
      fileChanged.safeParse({
        cwd: "/tmp/ws",
        kind: "deleted",
        path: "notes.md",
        version,
      }).success,
    ).toBe(false);
    expect(
      fileChanged.safeParse({
        cwd: "   ",
        kind: "deleted",
        path: "notes.md",
        version: null,
      }).success,
    ).toBe(false);
    expect(
      fileChanged.safeParse({
        cwd: "/tmp/ws",
        kind: "deleted",
        path: "notes.md",
        version: null,
        extra: true,
      }).success,
    ).toBe(false);
  });

  test("document save results reject unknown statuses and error kinds", () => {
    const save = jsonRpcWorkspaceResultSchemas["cowork/workspace/document/save"];
    expect(
      save.parse({
        ok: true,
        documentId: "doc-1",
        generation: 1,
        editRevision: 0,
        path: "notes.md",
        revision: version,
        status: "superseded",
      }),
    ).toMatchObject({ status: "superseded" });
    expect(
      save.safeParse({
        ok: true,
        documentId: "doc-1",
        generation: 1,
        editRevision: 0,
        path: "notes.md",
        revision: version,
        status: "conflict",
      }).success,
    ).toBe(false);
    expect(
      save.safeParse({
        ok: false,
        documentId: "doc-1",
        generation: 1,
        editRevision: 0,
        error: { kind: "stale", message: "nope" },
      }).success,
    ).toBe(false);
    expect(
      save.safeParse({
        ok: false,
        documentId: "doc-1",
        generation: 1,
        editRevision: 0,
        error: { kind: "conflict", message: "stale" },
        extra: true,
      }).success,
    ).toBe(false);
  });

  test("spreadsheet and presentation results reject unknown error kinds and extras", () => {
    const workbook = jsonRpcWorkspaceResultSchemas["cowork/workspace/spreadsheet/workbook"];
    const presentation = jsonRpcWorkspaceResultSchemas["cowork/workspace/presentation/preview"];
    expect(
      workbook.parse({
        ok: false,
        error: { kind: "outside_workspace", message: "escape" },
        warnings: [],
      }),
    ).toEqual({
      ok: false,
      error: { kind: "outside_workspace", message: "escape" },
      warnings: [],
    });
    expect(
      workbook.safeParse({
        ok: false,
        error: { kind: "permission_denied", message: "nope" },
        warnings: [],
      }).success,
    ).toBe(false);
    expect(
      workbook.safeParse({
        ok: false,
        error: { kind: "not_found", message: "missing" },
      }).success,
    ).toBe(false);
    expect(
      presentation.parse({
        ok: false,
        error: { kind: "no_slides", message: "empty" },
      }),
    ).toEqual({
      ok: false,
      error: { kind: "no_slides", message: "empty" },
    });
    expect(
      presentation.safeParse({
        ok: false,
        error: { kind: "outside_workspace", message: "escape" },
      }).success,
    ).toBe(false);
    expect(
      presentation.safeParse({
        ok: true,
        dependencies: ["soffice"],
        path: "deck.pptx",
        slides: [],
        version,
        extra: true,
      }).success,
    ).toBe(false);
  });
});
