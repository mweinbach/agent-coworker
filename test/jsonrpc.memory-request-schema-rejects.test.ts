import { describe, expect, test } from "bun:test";

import { jsonRpcMemoryRequestSchemas } from "../src/server/jsonrpc/schema.memory";

function expectReject(method: keyof typeof jsonRpcMemoryRequestSchemas, value: unknown) {
  expect(jsonRpcMemoryRequestSchemas[method].safeParse(value).success).toBe(false);
}

describe("memory request schemas", () => {
  test("plain memory upsert/delete require workspace|user scope and trim ids", () => {
    expect(
      jsonRpcMemoryRequestSchemas["cowork/memory/upsert"].parse({
        cwd: " /tmp/project ",
        scope: "workspace",
        id: "note-1",
        content: "remember this",
      }),
    ).toEqual({
      cwd: "/tmp/project",
      scope: "workspace",
      id: "note-1",
      content: "remember this",
    });
    expect(
      jsonRpcMemoryRequestSchemas["cowork/memory/delete"].parse({
        scope: "user",
        id: " note-1 ",
      }),
    ).toEqual({ scope: "user", id: "note-1" });

    expectReject("cowork/memory/upsert", { content: "x" });
    expectReject("cowork/memory/upsert", { scope: "global", content: "x" });
    expectReject("cowork/memory/upsert", { scope: "workspace", content: "x", extra: true });
    expectReject("cowork/memory/delete", { scope: "workspace", id: "  " });
    expectReject("cowork/memory/list", { scope: "plugin" });
  });

  test("advanced memory upsert/generate reject blank slugs, folders, and extras", () => {
    expect(
      jsonRpcMemoryRequestSchemas["cowork/memory/advanced/upsert"].parse({
        name: "Style",
        description: "How we write",
        body: "Be concise.",
      }),
    ).toEqual({
      name: "Style",
      description: "How we write",
      body: "Be concise.",
    });
    expect(
      jsonRpcMemoryRequestSchemas["cowork/memory/advanced/folder/upsert"].parse({
        folder: " team ",
        name: "Style",
        description: "How we write",
        body: "Be concise.",
      }),
    ).toMatchObject({ folder: "team" });

    expectReject("cowork/memory/advanced/upsert", {
      name: "Style",
      description: "How we write",
    });
    expectReject("cowork/memory/advanced/upsert", {
      name: "Style",
      description: "How we write",
      body: "Be concise.",
      extra: true,
    });
    expectReject("cowork/memory/advanced/delete", { slug: "" });
    expectReject("cowork/memory/advanced/generate", { threadId: "  " });
    expectReject("cowork/memory/advanced/folder/list", { folder: "   " });
    expectReject("cowork/memory/advanced/folder/upsert", {
      name: "Style",
      description: "How we write",
      body: "Be concise.",
    });
    expectReject("cowork/memory/advanced/folder/delete", { slug: "style", folder: "" });
    expectReject("cowork/memory/advanced/folder/generate", {
      threadId: "t1",
      folder: "team",
      extra: true,
    });
  });
});
