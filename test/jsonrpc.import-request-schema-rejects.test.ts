import { describe, expect, test } from "bun:test";

import { jsonRpcImportRequestSchemas } from "../src/server/jsonrpc/schema.import";

const previewSchema = jsonRpcImportRequestSchemas["cowork/conversationImport/preview"];
const sourcesSchema = jsonRpcImportRequestSchemas["cowork/conversationImport/sources/list"];
const mappingsSchema =
  jsonRpcImportRequestSchemas["cowork/conversationImport/workspaceMappings/validate"];
const importSchema = jsonRpcImportRequestSchemas["cowork/conversationImport/import"];

describe("conversation import request schemas", () => {
  test("accepts empty preview and sources/list params as defaults", () => {
    expect(sourcesSchema.parse(undefined)).toEqual({});
    expect(sourcesSchema.parse({})).toEqual({});
    expect(previewSchema.parse(undefined)).toEqual({});
    expect(previewSchema.parse({ limit: 25, includeArchived: false })).toEqual({
      limit: 25,
      includeArchived: false,
    });
  });

  test("rejects blank explicit paths, invalid sources, and out-of-range preview limits", () => {
    expect(sourcesSchema.safeParse({ explicitPaths: [" "] }).success).toBe(false);
    expect(sourcesSchema.safeParse({ sources: [{ source: "chatgpt" }] }).success).toBe(false);
    expect(sourcesSchema.safeParse({ sources: [{ source: "codex", path: "   " }] }).success).toBe(
      false,
    );
    expect(sourcesSchema.safeParse({ unexpected: true }).success).toBe(false);
    expect(previewSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(previewSchema.safeParse({ limit: 1001 }).success).toBe(false);
    expect(previewSchema.safeParse({ limit: 1.5 }).success).toBe(false);
  });

  test("rejects empty selected conversations and invalid import mappings", () => {
    expect(importSchema.safeParse({ selected: [] }).success).toBe(false);
    expect(
      importSchema.safeParse({
        selected: [{ source: "codex", fingerprint: "   " }],
      }).success,
    ).toBe(false);
    expect(
      importSchema.safeParse({
        selected: [{ source: "codex", fingerprint: "fp-1", extra: true }],
      }).success,
    ).toBe(false);
    expect(
      importSchema.safeParse({
        selected: [{ source: "codex", fingerprint: "fp-1" }],
        defaultModel: " ",
      }).success,
    ).toBe(false);
    expect(
      importSchema.safeParse({
        selected: [{ source: "codex", fingerprint: "fp-1" }],
        provider: "chatgpt",
      }).success,
    ).toBe(false);
    expect(
      importSchema.safeParse({
        selected: [{ source: "codex", fingerprint: "fp-1" }],
        mappings: {
          "fp-1": { kind: "create", path: " " },
        },
      }).success,
    ).toBe(false);
  });

  test("accepts a minimal valid import and mapping validate payload", () => {
    expect(
      importSchema.parse({
        selected: [{ source: "codex", fingerprint: " fp-1 " }],
        mappings: {
          "fp-1": { kind: "existing", workspaceId: " ws-1 " },
        },
        defaultProvider: "openai",
        defaultModel: " gpt-5.4 ",
      }),
    ).toEqual({
      selected: [{ source: "codex", fingerprint: "fp-1" }],
      mappings: {
        "fp-1": { kind: "existing", workspaceId: "ws-1" },
      },
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
    });

    expect(
      mappingsSchema.parse({
        mappings: {
          "fp-1": { kind: "create", path: " /tmp/imported ", name: " Imported " },
        },
      }),
    ).toEqual({
      mappings: {
        "fp-1": { kind: "create", path: "/tmp/imported", name: "Imported" },
      },
    });
  });

  test("rejects mapping validate extras and unknown kinds", () => {
    expect(mappingsSchema.safeParse({ mappings: {} }).success).toBe(true);
    expect(mappingsSchema.safeParse({}).success).toBe(false);
    expect(
      mappingsSchema.safeParse({
        mappings: { "fp-1": { kind: "reuse", workspaceId: "ws-1" } },
      }).success,
    ).toBe(false);
    expect(
      mappingsSchema.safeParse({
        mappings: { "fp-1": { kind: "existing", workspaceId: " " } },
      }).success,
    ).toBe(false);
    expect(
      mappingsSchema.safeParse({
        mappings: { "fp-1": { kind: "existing", workspaceId: "ws-1" } },
        extra: true,
      }).success,
    ).toBe(false);
  });
});
