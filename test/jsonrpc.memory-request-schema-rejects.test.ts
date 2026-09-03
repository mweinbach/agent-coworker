import { describe, expect, test } from "bun:test";

import { jsonRpcControlRequestSchemas } from "../src/shared/jsonrpcControlSchemas";

function rejects(schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false);
}

describe("memory request schema rejects", () => {
  test("upsert requires workspace or user scope", () => {
    const schema = jsonRpcControlRequestSchemas["cowork/memory/upsert"];
    expect(
      schema.parse({
        scope: "workspace",
        id: "hot",
        content: "remember this",
      }),
    ).toEqual({
      scope: "workspace",
      id: "hot",
      content: "remember this",
    });
    rejects(schema, { scope: "project", id: "hot", content: "remember this" });
    rejects(schema, { id: "hot", content: "remember this" });
    rejects(schema, {
      scope: "workspace",
      id: "hot",
      content: "remember this",
      extra: true,
    });
  });

  test("delete trims the memory id and rejects blanks", () => {
    const schema = jsonRpcControlRequestSchemas["cowork/memory/delete"];
    expect(schema.parse({ scope: "user", id: "  hot  " })).toEqual({
      scope: "user",
      id: "hot",
    });
    rejects(schema, { scope: "user", id: "   " });
    rejects(schema, { scope: "user" });
  });

  test("advanced upsert requires a body and folder upsert requires a folder", () => {
    const upsert = jsonRpcControlRequestSchemas["cowork/memory/advanced/upsert"];
    const folderUpsert = jsonRpcControlRequestSchemas["cowork/memory/advanced/folder/upsert"];
    expect(
      upsert.parse({
        name: "notes",
        description: "Daily notes",
        body: "hello",
      }),
    ).toEqual({
      name: "notes",
      description: "Daily notes",
      body: "hello",
    });
    rejects(upsert, { name: "notes", description: "Daily notes" });
    rejects(folderUpsert, {
      name: "notes",
      description: "Daily notes",
      body: "hello",
    });
    expect(
      folderUpsert.parse({
        folder: "  project  ",
        name: "notes",
        description: "Daily notes",
        body: "hello",
      }),
    ).toMatchObject({ folder: "project" });
  });

  test("generate and list reject blanks and extras", () => {
    const generate = jsonRpcControlRequestSchemas["cowork/memory/advanced/generate"];
    const folderGenerate = jsonRpcControlRequestSchemas["cowork/memory/advanced/folder/generate"];
    const folderList = jsonRpcControlRequestSchemas["cowork/memory/advanced/folder/list"];
    rejects(generate, { threadId: "   " });
    rejects(generate, { threadId: "thread-1", extra: true });
    rejects(folderGenerate, { threadId: "thread-1" });
    rejects(folderList, { folder: "   " });
    rejects(folderList, { folder: "project", extra: true });
    expect(folderList.parse({ folder: "  project  " })).toEqual({ folder: "project" });
  });
});
