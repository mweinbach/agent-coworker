import { describe, expect, test } from "bun:test";
import { jsonRpcThreadTurnRequestSchemas } from "../src/server/jsonrpc/schema.threadTurn";
import { MAX_TURN_ATTACHMENT_COUNT } from "../src/shared/attachments";
import { MAX_TOOL_RETRY_TARGETS } from "../src/shared/toolRetry";

const s = jsonRpcThreadTurnRequestSchemas;
const rejectsAll = (
  schema: { safeParse: (v: unknown) => { success: boolean } },
  cases: unknown[],
) => {
  for (const value of cases) expect(schema.safeParse(value).success).toBe(false);
};

describe("thread and turn request schema rejects", () => {
  test("thread/start and thread/resume trim ids and reject blanks or extras", () => {
    const start = s["thread/start"];
    const resume = s["thread/resume"];
    expect(start.parse({ cwd: " /workspace ", provider: " openai ", model: " gpt-5 " })).toEqual({
      cwd: "/workspace",
      provider: "openai",
      model: "gpt-5",
    });
    expect(start.parse({})).toEqual({});
    rejectsAll(start, [{ cwd: "   " }, { extra: true }]);

    expect(resume.parse({ threadId: " thread-1 ", afterSeq: 0 })).toEqual({
      threadId: "thread-1",
      afterSeq: 0,
    });
    rejectsAll(resume, [
      { threadId: "   " },
      { threadId: "thread-1", afterSeq: -1 },
      { threadId: "thread-1", afterSeq: 1.5 },
      { threadId: "thread-1", extra: true },
    ]);
  });

  test("turn/start rejects blank ids, extras, and oversized reference or retry lists", () => {
    const turnStart = s["turn/start"];
    expect(turnStart.parse({ threadId: " thread-1 ", input: "hello" })).toEqual({
      threadId: "thread-1",
      input: "hello",
    });
    rejectsAll(turnStart, [
      { threadId: "   ", input: "hello" },
      { threadId: "thread-1" },
      { threadId: "thread-1", input: "hello", extra: true },
      {
        threadId: "thread-1",
        input: "hello",
        references: Array.from({ length: 33 }, (_, i) => ({ kind: "skill", name: `s${i}` })),
      },
      { threadId: "thread-1", input: "hello", references: [{ kind: "mcp", name: "search" }] },
      { threadId: "thread-1", input: "hello", references: [{ kind: "skill", name: "   " }] },
      { threadId: "thread-1", input: "hello", retry: { toolItemIds: [] } },
      {
        threadId: "thread-1",
        input: "hello",
        retry: {
          toolItemIds: Array.from({ length: MAX_TOOL_RETRY_TARGETS + 1 }, (_, i) => `t${i}`),
        },
      },
    ]);
  });

  test("turn/start and turn/steer reject too many attachments", () => {
    const attachments = Array.from({ length: MAX_TURN_ATTACHMENT_COUNT + 1 }, (_, i) => ({
      type: "uploadedFile" as const,
      filename: `file-${i}.md`,
      path: `/tmp/file-${i}.md`,
      mimeType: "text/markdown",
    }));
    rejectsAll(s["turn/start"], [{ threadId: "thread-1", input: attachments }]);
    rejectsAll(s["turn/steer"], [{ threadId: "thread-1", input: attachments }]);
    expect(
      s["turn/start"].parse({
        threadId: "thread-1",
        input: attachments.slice(0, MAX_TURN_ATTACHMENT_COUNT),
      }),
    ).toMatchObject({ threadId: "thread-1" });
  });
});
