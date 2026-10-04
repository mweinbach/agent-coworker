import { describe, expect, test } from "bun:test";
import { jsonRpcSessionRequestSchemas } from "../src/server/jsonrpc/schema.session";

const s = jsonRpcSessionRequestSchemas;
const rejectsAll = (
  schema: { safeParse: (v: unknown) => { success: boolean } },
  cases: unknown[],
) => {
  for (const value of cases) expect(schema.safeParse(value).success).toBe(false);
};

const harnessContext = {
  runId: "run-1",
  objective: "Ship the report",
  acceptanceCriteria: ["draft ready"],
  constraints: ["no secrets"],
};

describe("session request schema rejects", () => {
  test("title/set trims ids and rejects blanks or extras", () => {
    const schema = s["cowork/session/title/set"];
    expect(schema.parse({ threadId: " thread-1 ", title: " Weekly review " })).toEqual({
      threadId: "thread-1",
      title: "Weekly review",
    });
    rejectsAll(schema, [
      { threadId: "   ", title: "Weekly review" },
      { threadId: "thread-1", title: "   " },
      { title: "Weekly review" },
      { threadId: "thread-1", title: "Weekly review", extra: true },
    ]);
  });

  test("model/set requires a model and trims optional provider", () => {
    const schema = s["cowork/session/model/set"];
    expect(
      schema.parse({ threadId: " thread-1 ", provider: " openai ", model: " gpt-5 " }),
    ).toEqual({
      threadId: "thread-1",
      provider: "openai",
      model: "gpt-5",
    });
    expect(schema.parse({ threadId: "thread-1", model: "gpt-5" })).toEqual({
      threadId: "thread-1",
      model: "gpt-5",
    });
    rejectsAll(schema, [
      { threadId: "thread-1", provider: "openai" },
      { threadId: "thread-1", model: "   " },
      { threadId: "thread-1", provider: "   ", model: "gpt-5" },
      { threadId: "thread-1", model: "gpt-5", extra: true },
    ]);
  });

  test("usageBudget/set accepts nullable thresholds and rejects extras", () => {
    const schema = s["cowork/session/usageBudget/set"];
    expect(schema.parse({ threadId: " thread-1 ", warnAtUsd: 2.5, stopAtUsd: null })).toEqual({
      threadId: "thread-1",
      warnAtUsd: 2.5,
      stopAtUsd: null,
    });
    rejectsAll(schema, [{ threadId: "   " }, { threadId: "thread-1", extra: true }]);
  });

  test("harnessContext/set requires a strict payload and trims ids", () => {
    const schema = s["cowork/session/harnessContext/set"];
    expect(
      schema.parse({
        threadId: " thread-1 ",
        context: { ...harnessContext, runId: " run-1 ", taskId: " task-1 " },
      }),
    ).toEqual({
      threadId: "thread-1",
      context: { ...harnessContext, runId: "run-1", taskId: "task-1" },
    });
    rejectsAll(schema, [
      { threadId: "thread-1" },
      { threadId: "thread-1", context: { ...harnessContext, runId: "   " } },
      { threadId: "thread-1", context: { ...harnessContext, extra: true } },
      { threadId: "thread-1", context: { ...harnessContext, metadata: { note: 1 } } },
    ]);
    rejectsAll(s["cowork/session/harnessContext/get"], [
      { threadId: "   " },
      { threadId: "thread-1", extra: true },
    ]);
  });

  test("file/upload and delete reject blanks, missing fields, and extras", () => {
    const upload = s["cowork/session/file/upload"];
    const remove = s["cowork/session/delete"];
    expect(
      upload.parse({ cwd: " /workspace ", filename: " notes.md ", contentBase64: "YQ==" }),
    ).toEqual({ cwd: "/workspace", filename: "notes.md", contentBase64: "YQ==" });
    rejectsAll(upload, [
      { filename: "notes.md" },
      { filename: "   ", contentBase64: "YQ==" },
      { filename: "notes.md", contentBase64: "" },
      { cwd: "   ", filename: "notes.md", contentBase64: "YQ==" },
      { filename: "notes.md", contentBase64: "YQ==", extra: true },
    ]);

    expect(remove.parse({ cwd: " /workspace ", targetSessionId: " session-1 " })).toEqual({
      cwd: "/workspace",
      targetSessionId: "session-1",
    });
    rejectsAll(remove, [
      { targetSessionId: "   " },
      { cwd: "/workspace" },
      { targetSessionId: "session-1", extra: true },
    ]);
  });
});
