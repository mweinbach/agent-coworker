import { describe, expect, test } from "bun:test";

import { jsonRpcThreadTurnRequestSchemas } from "../src/server/jsonrpc/schema.threadTurn";
import { MAX_TURN_ATTACHMENT_COUNT } from "../src/shared/attachments";
import { MAX_TOOL_RETRY_TARGETS } from "../src/shared/toolRetry";

function rejects(schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false);
}

const turnStart = jsonRpcThreadTurnRequestSchemas["turn/start"];
const turnSteer = jsonRpcThreadTurnRequestSchemas["turn/steer"];

describe("thread and turn request schema rejects", () => {
  test("thread/start and thread/resume trim ids and reject blanks or extras", () => {
    const start = jsonRpcThreadTurnRequestSchemas["thread/start"];
    const resume = jsonRpcThreadTurnRequestSchemas["thread/resume"];
    expect(start.parse({ cwd: " /workspace ", provider: " openai ", model: " gpt-5 " })).toEqual({
      cwd: "/workspace",
      provider: "openai",
      model: "gpt-5",
    });
    expect(start.parse({})).toEqual({});
    rejects(start, { cwd: "   " });
    rejects(start, { extra: true });
    expect(resume.parse({ threadId: " thread-1 ", afterSeq: 0 })).toEqual({
      threadId: "thread-1",
      afterSeq: 0,
    });
    rejects(resume, { threadId: "   " });
    rejects(resume, { threadId: "thread-1", afterSeq: -1 });
    rejects(resume, { threadId: "thread-1", afterSeq: 1.5 });
    rejects(resume, { threadId: "thread-1", extra: true });
  });

  test("turn/start rejects blank ids, extras, and oversized reference or retry lists", () => {
    expect(turnStart.parse({ threadId: " thread-1 ", input: "hello" })).toEqual({
      threadId: "thread-1",
      input: "hello",
    });
    rejects(turnStart, { threadId: "   ", input: "hello" });
    rejects(turnStart, { threadId: "thread-1" });
    rejects(turnStart, { threadId: "thread-1", input: "hello", extra: true });
    rejects(turnStart, {
      threadId: "thread-1",
      input: "hello",
      references: Array.from({ length: 33 }, (_, index) => ({ kind: "skill", name: `s${index}` })),
    });
    rejects(turnStart, {
      threadId: "thread-1",
      input: "hello",
      references: [{ kind: "mcp", name: "search" }],
    });
    rejects(turnStart, {
      threadId: "thread-1",
      input: "hello",
      references: [{ kind: "skill", name: "   " }],
    });
    rejects(turnStart, {
      threadId: "thread-1",
      input: "hello",
      retry: { toolItemIds: [] },
    });
    rejects(turnStart, {
      threadId: "thread-1",
      input: "hello",
      retry: { toolItemIds: Array.from({ length: MAX_TOOL_RETRY_TARGETS + 1 }, (_, i) => `t${i}`) },
    });
  });

  test("turn/start and turn/steer reject too many attachments", () => {
    const attachments = Array.from({ length: MAX_TURN_ATTACHMENT_COUNT + 1 }, (_, index) => ({
      type: "uploadedFile" as const,
      filename: `file-${index}.md`,
      path: `/tmp/file-${index}.md`,
      mimeType: "text/markdown",
    }));
    rejects(turnStart, { threadId: "thread-1", input: attachments });
    rejects(turnSteer, { threadId: "thread-1", input: attachments });
    expect(
      turnStart.parse({
        threadId: "thread-1",
        input: attachments.slice(0, MAX_TURN_ATTACHMENT_COUNT),
      }),
    ).toMatchObject({ threadId: "thread-1" });
  });
});
