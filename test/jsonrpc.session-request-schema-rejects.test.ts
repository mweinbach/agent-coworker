import { describe, expect, test } from "bun:test";

import { jsonRpcSessionRequestSchemas } from "../src/server/jsonrpc/schema.session";

function rejects(schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false);
}

const harnessContext = {
  runId: "run-1",
  objective: "Ship the report",
  acceptanceCriteria: ["draft ready"],
  constraints: ["no secrets"],
};

describe("session request schema rejects", () => {
  test("title/set trims ids and rejects blanks or extras", () => {
    const schema = jsonRpcSessionRequestSchemas["cowork/session/title/set"];
    expect(schema.parse({ threadId: " thread-1 ", title: " Weekly review " })).toEqual({
      threadId: "thread-1",
      title: "Weekly review",
    });
    rejects(schema, { threadId: "   ", title: "Weekly review" });
    rejects(schema, { threadId: "thread-1", title: "   " });
    rejects(schema, { title: "Weekly review" });
    rejects(schema, { threadId: "thread-1", title: "Weekly review", extra: true });
  });

  test("model/set requires a model and trims optional provider", () => {
    const schema = jsonRpcSessionRequestSchemas["cowork/session/model/set"];
    expect(
      schema.parse({
        threadId: " thread-1 ",
        provider: " openai ",
        model: " gpt-5 ",
      }),
    ).toEqual({
      threadId: "thread-1",
      provider: "openai",
      model: "gpt-5",
    });
    expect(schema.parse({ threadId: "thread-1", model: "gpt-5" })).toEqual({
      threadId: "thread-1",
      model: "gpt-5",
    });
    rejects(schema, { threadId: "thread-1", provider: "openai" });
    rejects(schema, { threadId: "thread-1", model: "   " });
    rejects(schema, { threadId: "thread-1", provider: "   ", model: "gpt-5" });
    rejects(schema, { threadId: "thread-1", model: "gpt-5", extra: true });
  });

  test("usageBudget/set accepts nullable thresholds and rejects extras", () => {
    const schema = jsonRpcSessionRequestSchemas["cowork/session/usageBudget/set"];
    expect(
      schema.parse({
        threadId: " thread-1 ",
        warnAtUsd: 2.5,
        stopAtUsd: null,
      }),
    ).toEqual({
      threadId: "thread-1",
      warnAtUsd: 2.5,
      stopAtUsd: null,
    });
    rejects(schema, { threadId: "   " });
    rejects(schema, { threadId: "thread-1", extra: true });
  });

  test("harnessContext/set requires a strict payload and trims ids", () => {
    const schema = jsonRpcSessionRequestSchemas["cowork/session/harnessContext/set"];
    expect(
      schema.parse({
        threadId: " thread-1 ",
        context: { ...harnessContext, runId: " run-1 ", taskId: " task-1 " },
      }),
    ).toEqual({
      threadId: "thread-1",
      context: { ...harnessContext, runId: "run-1", taskId: "task-1" },
    });
    rejects(schema, { threadId: "thread-1" });
    rejects(schema, {
      threadId: "thread-1",
      context: { ...harnessContext, runId: "   " },
    });
    rejects(schema, {
      threadId: "thread-1",
      context: { ...harnessContext, extra: true },
    });
    rejects(schema, {
      threadId: "thread-1",
      context: { ...harnessContext, metadata: { note: 1 } },
    });
    rejects(jsonRpcSessionRequestSchemas["cowork/session/harnessContext/get"], { threadId: "   " });
    rejects(jsonRpcSessionRequestSchemas["cowork/session/harnessContext/get"], {
      threadId: "thread-1",
      extra: true,
    });
  });

  test("file/upload and delete reject blanks, missing fields, and extras", () => {
    const upload = jsonRpcSessionRequestSchemas["cowork/session/file/upload"];
    const remove = jsonRpcSessionRequestSchemas["cowork/session/delete"];
    expect(
      upload.parse({
        cwd: " /workspace ",
        filename: " notes.md ",
        contentBase64: "YQ==",
      }),
    ).toEqual({
      cwd: "/workspace",
      filename: "notes.md",
      contentBase64: "YQ==",
    });
    rejects(upload, { filename: "notes.md" });
    rejects(upload, { filename: "   ", contentBase64: "YQ==" });
    rejects(upload, { filename: "notes.md", contentBase64: "" });
    rejects(upload, { cwd: "   ", filename: "notes.md", contentBase64: "YQ==" });
    rejects(upload, { filename: "notes.md", contentBase64: "YQ==", extra: true });

    expect(remove.parse({ cwd: " /workspace ", targetSessionId: " session-1 " })).toEqual({
      cwd: "/workspace",
      targetSessionId: "session-1",
    });
    rejects(remove, { targetSessionId: "   " });
    rejects(remove, { cwd: "/workspace" });
    rejects(remove, { targetSessionId: "session-1", extra: true });
  });
});
