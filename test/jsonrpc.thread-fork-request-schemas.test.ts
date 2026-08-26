import { describe, expect, test } from "bun:test";

import { jsonRpcThreadManagementRequestSchemas } from "../src/server/jsonrpc/schema.threadManagement";

const schema = jsonRpcThreadManagementRequestSchemas["thread/fork"];

describe("thread/fork request schema", () => {
  test("accepts a thread id with optional local or worktree environments", () => {
    expect(schema.parse({ threadId: "thread-1" })).toEqual({ threadId: "thread-1" });
    expect(
      schema.parse({
        threadId: " thread-1 ",
        environment: { type: "local" },
        title: " Forked ",
        prompt: "continue",
        model: "gpt-5.4",
        thinking: "high",
      }),
    ).toEqual({
      threadId: "thread-1",
      environment: { type: "local" },
      title: "Forked",
      prompt: "continue",
      model: "gpt-5.4",
      thinking: "high",
    });
    expect(
      schema.parse({
        threadId: "thread-1",
        environment: {
          type: "worktree",
          ref: "main",
          branchName: "fork/topic",
          startingState: { ref: "abc123", branchName: "main" },
        },
      }),
    ).toEqual({
      threadId: "thread-1",
      environment: {
        type: "worktree",
        ref: "main",
        branchName: "fork/topic",
        startingState: { ref: "abc123", branchName: "main" },
      },
    });
  });

  test("rejects blank ids, unknown environments, and extra fields", () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ threadId: "  " }).success).toBe(false);
    expect(schema.safeParse({ threadId: "thread-1", extra: true }).success).toBe(false);
    expect(schema.safeParse({ threadId: "thread-1", title: "  " }).success).toBe(false);
    expect(
      schema.safeParse({ threadId: "thread-1", environment: { type: "remote" } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ threadId: "thread-1", environment: { type: "local", cwd: "/tmp" } })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        threadId: "thread-1",
        environment: { type: "worktree", ref: "  " },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        threadId: "thread-1",
        environment: { type: "worktree", startingState: { ref: "  " } },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        threadId: "thread-1",
        environment: { type: "worktree", startingState: { ref: "main", extra: true } },
      }).success,
    ).toBe(false);
  });
});
