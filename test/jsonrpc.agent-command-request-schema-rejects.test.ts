import { describe, expect, test } from "bun:test";

import { jsonRpcAgentRequestSchemas } from "../src/server/jsonrpc/schema.agents";
import { jsonRpcCommandRequestSchemas } from "../src/server/jsonrpc/schema.commands";

const waitSchema = jsonRpcAgentRequestSchemas["cowork/session/agent/wait"];
const executeSchema = jsonRpcCommandRequestSchemas["command/execute"];
const listSchema = jsonRpcCommandRequestSchemas["command/list"];

describe("agent wait and command execute request schemas", () => {
  test("accepts a trimmed wait request with at least one agent id", () => {
    expect(
      waitSchema.parse({
        threadId: " thread-1 ",
        agentIds: [" agent-1 "],
        timeoutMs: 0,
        mode: "any",
      }),
    ).toEqual({
      threadId: "thread-1",
      agentIds: ["agent-1"],
      timeoutMs: 0,
      mode: "any",
    });
  });

  test("rejects empty, blank, or malformed agent wait params", () => {
    expect(waitSchema.safeParse({ threadId: "thread-1", agentIds: [] }).success).toBe(false);
    expect(waitSchema.safeParse({ threadId: "thread-1", agentIds: [" "] }).success).toBe(false);
    expect(waitSchema.safeParse({ agentIds: ["agent-1"] }).success).toBe(false);
    expect(waitSchema.safeParse({ threadId: " ", agentIds: ["agent-1"] }).success).toBe(false);
    expect(
      waitSchema.safeParse({
        threadId: "thread-1",
        agentIds: ["agent-1"],
        timeoutMs: -1,
      }).success,
    ).toBe(false);
    expect(
      waitSchema.safeParse({
        threadId: "thread-1",
        agentIds: ["agent-1"],
        timeoutMs: 1.5,
      }).success,
    ).toBe(false);
    expect(
      waitSchema.safeParse({
        threadId: "thread-1",
        agentIds: ["agent-1"],
        mode: "both",
      }).success,
    ).toBe(false);
    expect(
      waitSchema.safeParse({
        threadId: "thread-1",
        agentIds: ["agent-1"],
        extra: true,
      }).success,
    ).toBe(false);
  });

  test("accepts trimmed command execute params and rejects blanks or extras", () => {
    expect(
      executeSchema.parse({
        threadId: " chat-1 ",
        name: " task ",
        arguments: "Build the report",
        clientMessageId: " client-1 ",
      }),
    ).toEqual({
      threadId: "chat-1",
      name: "task",
      arguments: "Build the report",
      clientMessageId: "client-1",
    });

    expect(executeSchema.safeParse({ threadId: "chat-1", name: " " }).success).toBe(false);
    expect(executeSchema.safeParse({ threadId: "\n", name: "task" }).success).toBe(false);
    expect(executeSchema.safeParse({ name: "task" }).success).toBe(false);
    expect(
      executeSchema.safeParse({
        threadId: "chat-1",
        name: "task",
        extra: true,
      }).success,
    ).toBe(false);
    expect(listSchema.safeParse({ threadId: " " }).success).toBe(false);
  });
});
