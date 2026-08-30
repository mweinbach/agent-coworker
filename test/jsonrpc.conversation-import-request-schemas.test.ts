import { describe, expect, test } from "bun:test";

import {
  jsonRpcImportRequestSchemas,
  jsonRpcImportResultSchemas,
} from "../src/server/jsonrpc/schema.import";

const sourcesList = jsonRpcImportRequestSchemas["cowork/conversationImport/sources/list"];
const preview = jsonRpcImportRequestSchemas["cowork/conversationImport/preview"];
const validate =
  jsonRpcImportRequestSchemas["cowork/conversationImport/workspaceMappings/validate"];
const importConversations = jsonRpcImportRequestSchemas["cowork/conversationImport/import"];

const sourcesListResult = jsonRpcImportResultSchemas["cowork/conversationImport/sources/list"];
const previewResult = jsonRpcImportResultSchemas["cowork/conversationImport/preview"];
const validateResult =
  jsonRpcImportResultSchemas["cowork/conversationImport/workspaceMappings/validate"];
const importResult = jsonRpcImportResultSchemas["cowork/conversationImport/import"];

const validSource = { source: "codex" as const, path: "/tmp/codex-state.sqlite" };
const validSelected = { source: "codex" as const, fingerprint: "fp-1" };

describe("conversation import request schemas", () => {
  test("sources/list defaults to empty params and rejects extras or unknown sources", () => {
    expect(sourcesList.parse(undefined)).toEqual({});
    expect(sourcesList.parse({})).toEqual({});
    expect(
      sourcesList.parse({
        sources: [validSource],
        includeCodex: true,
        explicitPaths: [" /tmp/extra "],
      }),
    ).toEqual({
      sources: [validSource],
      includeCodex: true,
      explicitPaths: ["/tmp/extra"],
    });
    expect(sourcesList.safeParse({ extra: true }).success).toBe(false);
    expect(sourcesList.safeParse({ sources: [{ source: "chatgpt" }] }).success).toBe(false);
    expect(sourcesList.safeParse({ sources: [{ source: "codex", path: "   " }] }).success).toBe(
      false,
    );
    expect(sourcesList.safeParse({ explicitPaths: [""] }).success).toBe(false);
  });

  test("preview rejects non-positive, fractional, or oversized limits", () => {
    expect(preview.parse({ limit: 1 })).toEqual({ limit: 1 });
    expect(preview.parse({ limit: 1000 })).toEqual({ limit: 1000 });
    expect(preview.safeParse({ limit: 0 }).success).toBe(false);
    expect(preview.safeParse({ limit: 1001 }).success).toBe(false);
    expect(preview.safeParse({ limit: 1.5 }).success).toBe(false);
    expect(preview.safeParse({ limit: -1 }).success).toBe(false);
    expect(preview.safeParse({ extra: true }).success).toBe(false);
  });

  test("workspaceMappings/validate accepts mapping kinds and rejects blank ids or extras", () => {
    expect(
      validate.parse({
        mappings: {
          "fp-1": { kind: "existing", workspaceId: " ws-1 " },
          "fp-2": { kind: "fallback", workspaceId: "ws-2" },
          "fp-3": { kind: "create", path: " /tmp/new ", name: " New " },
        },
      }),
    ).toEqual({
      mappings: {
        "fp-1": { kind: "existing", workspaceId: "ws-1" },
        "fp-2": { kind: "fallback", workspaceId: "ws-2" },
        "fp-3": { kind: "create", path: "/tmp/new", name: "New" },
      },
    });
    expect(validate.safeParse({}).success).toBe(false);
    expect(
      validate.safeParse({ mappings: { "fp-1": { kind: "existing", workspaceId: "  " } } }).success,
    ).toBe(false);
    expect(validate.safeParse({ mappings: { "fp-1": { kind: "create", path: "" } } }).success).toBe(
      false,
    );
    expect(
      validate.safeParse({ mappings: { "fp-1": { kind: "skip", workspaceId: "ws-1" } } }).success,
    ).toBe(false);
    expect(
      validate.safeParse({
        mappings: { "fp-1": { kind: "existing", workspaceId: "ws-1", extra: true } },
      }).success,
    ).toBe(false);
    expect(
      validate.safeParse({
        mappings: { "fp-1": { kind: "existing", workspaceId: "ws-1" } },
        extra: true,
      }).success,
    ).toBe(false);
  });

  test("import requires a selected conversation and rejects unknown providers or extras", () => {
    expect(
      importConversations.parse({
        selected: [validSelected],
        sources: [validSource],
        provider: "openai",
        model: " gpt-5.5 ",
        mode: "skip-existing",
      }),
    ).toEqual({
      selected: [validSelected],
      sources: [validSource],
      provider: "openai",
      model: "gpt-5.5",
      mode: "skip-existing",
    });
    expect(importConversations.safeParse({ selected: [] }).success).toBe(false);
    expect(
      importConversations.safeParse({
        selected: [{ source: "codex", fingerprint: "   " }],
      }).success,
    ).toBe(false);
    expect(
      importConversations.safeParse({
        selected: [{ source: "chatgpt", fingerprint: "fp-1" }],
      }).success,
    ).toBe(false);
    expect(
      importConversations.safeParse({
        selected: [validSelected],
        provider: "chatgpt",
      }).success,
    ).toBe(false);
    expect(
      importConversations.safeParse({
        selected: [validSelected],
        mode: "overwrite",
      }).success,
    ).toBe(false);
    expect(
      importConversations.safeParse({
        selected: [validSelected],
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("conversation import result schemas", () => {
  test("sources/list rejects extra keys, unknown sources, and negative counts", () => {
    expect(
      sourcesListResult.parse({
        sources: [
          {
            source: "codex",
            id: "codex-home",
            path: "/tmp/state.sqlite",
            available: true,
            conversationCount: 0,
          },
        ],
      }),
    ).toEqual({
      sources: [
        {
          source: "codex",
          id: "codex-home",
          path: "/tmp/state.sqlite",
          available: true,
          conversationCount: 0,
        },
      ],
    });
    expect(
      sourcesListResult.safeParse({
        sources: [
          {
            source: "chatgpt",
            id: "x",
            path: "/tmp",
            available: true,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      sourcesListResult.safeParse({
        sources: [
          {
            source: "codex",
            id: "x",
            path: "/tmp",
            available: true,
            conversationCount: -1,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      sourcesListResult.safeParse({
        sources: [
          {
            source: "codex",
            id: "x",
            path: "/tmp",
            available: true,
            extra: true,
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("preview rejects unknown warning codes and extra mapping fields", () => {
    const conversation = {
      source: "claude-code" as const,
      sourceId: "id-1",
      sourcePath: null,
      fingerprint: "fp-1",
      title: "Imported",
      cwd: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      originalProvider: null,
      originalModel: null,
      messageCount: 0,
      toolCount: 0,
      warnings: [{ code: "missing_cwd" as const, message: "no cwd" }],
      mapping: { status: "missing" as const, originalPath: null, reason: "no_cwd" as const },
      alreadyImportedThreadId: null,
    };
    expect(previewResult.parse({ conversations: [conversation] })).toEqual({
      conversations: [conversation],
    });
    expect(
      previewResult.safeParse({
        conversations: [
          {
            ...conversation,
            warnings: [{ code: "unknown", message: "nope" }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      previewResult.safeParse({
        conversations: [
          {
            ...conversation,
            mapping: { status: "matched", workspaceId: "ws-1", workspacePath: "/tmp", extra: true },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      previewResult.safeParse({
        conversations: [
          {
            ...conversation,
            messageCount: -1,
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("validate and import results reject extras and unknown skip reasons", () => {
    expect(
      validateResult.parse({
        valid: false,
        mappings: {},
        errors: [{ fingerprint: "fp-1", message: "missing" }],
      }),
    ).toEqual({
      valid: false,
      mappings: {},
      errors: [{ fingerprint: "fp-1", message: "missing" }],
    });
    expect(
      validateResult.safeParse({
        valid: false,
        mappings: {},
        errors: [{ fingerprint: "fp-1", message: "missing", extra: true }],
      }).success,
    ).toBe(false);

    expect(
      importResult.parse({
        imported: [],
        skipped: [
          {
            source: "cowork",
            fingerprint: "fp-1",
            existingThreadId: "thread-1",
            reason: "already_imported",
          },
        ],
        failed: [{ source: "cowork", fingerprint: "fp-2", message: "broken" }],
        createdWorkspaces: [],
      }),
    ).toEqual({
      imported: [],
      skipped: [
        {
          source: "cowork",
          fingerprint: "fp-1",
          existingThreadId: "thread-1",
          reason: "already_imported",
        },
      ],
      failed: [{ source: "cowork", fingerprint: "fp-2", message: "broken" }],
      createdWorkspaces: [],
    });
    expect(
      importResult.safeParse({
        imported: [],
        skipped: [
          {
            source: "cowork",
            fingerprint: "fp-1",
            existingThreadId: "thread-1",
            reason: "duplicate",
          },
        ],
        failed: [],
        createdWorkspaces: [],
      }).success,
    ).toBe(false);
    expect(
      importResult.safeParse({
        imported: [],
        skipped: [],
        failed: [],
        createdWorkspaces: [],
        extra: true,
      }).success,
    ).toBe(false);
  });
});
