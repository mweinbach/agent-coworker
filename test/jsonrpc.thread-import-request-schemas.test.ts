import { describe, expect, test } from "bun:test";

import { jsonRpcRequestSchemas } from "../src/server/jsonrpc/schema";

describe("thread management JSON-RPC request schemas", () => {
  test("thread/fork accepts local and worktree environments", () => {
    expect(
      jsonRpcRequestSchemas["thread/fork"].parse({
        threadId: "thread-1",
        environment: { type: "local" },
      }),
    ).toEqual({
      threadId: "thread-1",
      environment: { type: "local" },
    });
    expect(
      jsonRpcRequestSchemas["thread/fork"].parse({
        threadId: "thread-1",
        environment: {
          type: "worktree",
          ref: "main",
          branchName: "fork/topic",
        },
      }),
    ).toEqual({
      threadId: "thread-1",
      environment: {
        type: "worktree",
        ref: "main",
        branchName: "fork/topic",
      },
    });
  });

  test("thread/fork rejects blank ids, unknown environments, and extra fields", () => {
    expect(() => jsonRpcRequestSchemas["thread/fork"].parse({ threadId: "   " })).toThrow();
    expect(() =>
      jsonRpcRequestSchemas["thread/fork"].parse({
        threadId: "thread-1",
        environment: { type: "remote" },
      }),
    ).toThrow();
    expect(() =>
      jsonRpcRequestSchemas["thread/fork"].parse({
        threadId: "thread-1",
        environment: { type: "worktree", extra: true },
      }),
    ).toThrow();
    expect(() =>
      jsonRpcRequestSchemas["thread/fork"].parse({
        threadId: "thread-1",
        queued: true,
      }),
    ).toThrow();
  });

  test("thread pin and archive flags stay boolean-only", () => {
    expect(
      jsonRpcRequestSchemas["thread/pinned/set"].parse({
        threadId: "thread-1",
        pinned: true,
      }),
    ).toEqual({ threadId: "thread-1", pinned: true });
    expect(() =>
      jsonRpcRequestSchemas["thread/pinned/set"].parse({
        threadId: "thread-1",
        pinned: "yes",
      }),
    ).toThrow();
    expect(() =>
      jsonRpcRequestSchemas["thread/archived/set"].parse({
        threadId: "thread-1",
        archived: 1,
      }),
    ).toThrow();
  });
});

describe("conversation import JSON-RPC request schemas", () => {
  test("import requires a non-empty selected list with known sources", () => {
    expect(() =>
      jsonRpcRequestSchemas["cowork/conversationImport/import"].parse({
        selected: [],
      }),
    ).toThrow();
    expect(() =>
      jsonRpcRequestSchemas["cowork/conversationImport/import"].parse({
        selected: [{ source: "chatgpt", fingerprint: "fp-1" }],
      }),
    ).toThrow();
    expect(() =>
      jsonRpcRequestSchemas["cowork/conversationImport/import"].parse({
        selected: [{ source: "codex", fingerprint: "   " }],
      }),
    ).toThrow();

    expect(
      jsonRpcRequestSchemas["cowork/conversationImport/import"].parse({
        selected: [{ source: "codex", fingerprint: "fp-1" }],
      }),
    ).toEqual({
      selected: [{ source: "codex", fingerprint: "fp-1" }],
    });
  });

  test("workspace mapping validation rejects unknown kinds and extra fields", () => {
    expect(() =>
      jsonRpcRequestSchemas["cowork/conversationImport/workspaceMappings/validate"].parse({
        mappings: {
          "fp-1": { kind: "clone", workspaceId: "ws-1" },
        },
      }),
    ).toThrow();
    expect(() =>
      jsonRpcRequestSchemas["cowork/conversationImport/workspaceMappings/validate"].parse({
        mappings: {
          "fp-1": { kind: "existing", workspaceId: "ws-1", extra: true },
        },
      }),
    ).toThrow();
    expect(() =>
      jsonRpcRequestSchemas["cowork/conversationImport/workspaceMappings/validate"].parse({
        mappings: {
          "fp-1": { kind: "create", path: "   " },
        },
      }),
    ).toThrow();

    expect(
      jsonRpcRequestSchemas["cowork/conversationImport/workspaceMappings/validate"].parse({
        mappings: {
          "fp-1": { kind: "existing", workspaceId: "ws-1" },
          "fp-2": { kind: "create", path: "/tmp/imported", name: "Imported" },
        },
      }),
    ).toEqual({
      mappings: {
        "fp-1": { kind: "existing", workspaceId: "ws-1" },
        "fp-2": { kind: "create", path: "/tmp/imported", name: "Imported" },
      },
    });
  });

  test("preview rejects extra fields and non-positive limits", () => {
    expect(() =>
      jsonRpcRequestSchemas["cowork/conversationImport/preview"].parse({
        limit: 0,
      }),
    ).toThrow();
    expect(() =>
      jsonRpcRequestSchemas["cowork/conversationImport/preview"].parse({
        unexpected: true,
      }),
    ).toThrow();
    expect(jsonRpcRequestSchemas["cowork/conversationImport/preview"].parse({})).toEqual({});
  });
});
