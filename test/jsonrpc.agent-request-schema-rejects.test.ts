import { describe, expect, test } from "bun:test";

import {
  jsonRpcAgentNotificationSchemas,
  jsonRpcAgentRequestSchemas,
  jsonRpcAgentResultSchemas,
} from "../src/server/jsonrpc/schema.agents";

const spawn = jsonRpcAgentRequestSchemas["cowork/session/agent/spawn"];
const wait = jsonRpcAgentRequestSchemas["cowork/session/agent/wait"];
const sendInput = jsonRpcAgentRequestSchemas["cowork/session/agent/input/send"];
const inspect = jsonRpcAgentRequestSchemas["cowork/session/agent/inspect"];
const resume = jsonRpcAgentRequestSchemas["cowork/session/agent/resume"];
const close = jsonRpcAgentRequestSchemas["cowork/session/agent/close"];
const list = jsonRpcAgentRequestSchemas["cowork/session/agent/list"];

describe("agent request schema rejects", () => {
  test("spawn rejects blank ids, unknown roles, extras, and brief-without-briefing", () => {
    expect(
      spawn.parse({
        threadId: " thread-1 ",
        message: " Plan the refactor ",
        role: "worker",
      }),
    ).toEqual({
      threadId: "thread-1",
      message: "Plan the refactor",
      role: "worker",
    });
    expect(spawn.safeParse({ threadId: "   ", message: "go" }).success).toBe(false);
    expect(spawn.safeParse({ threadId: "thread-1", message: "   " }).success).toBe(false);
    expect(spawn.safeParse({ threadId: "thread-1", message: "go", role: "admin" }).success).toBe(
      false,
    );
    expect(spawn.safeParse({ threadId: "thread-1", message: "go", extra: true }).success).toBe(
      false,
    );
    expect(
      spawn.safeParse({
        threadId: "thread-1",
        message: "go",
        contextMode: "brief",
      }).success,
    ).toBe(false);
    expect(
      spawn.safeParse({
        threadId: "thread-1",
        message: "go",
        targetPaths: ["   "],
      }).success,
    ).toBe(false);
    expect(
      spawn.parse({
        threadId: "thread-1",
        message: "go",
        contextMode: "brief",
        briefing: " Check auth first ",
      }),
    ).toMatchObject({
      contextMode: "brief",
      briefing: "Check auth first",
    });
  });

  test("wait rejects empty agent ids, negative timeouts, unknown modes, and extras", () => {
    expect(
      wait.parse({
        threadId: "thread-1",
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
    expect(wait.safeParse({ threadId: "thread-1", agentIds: [] }).success).toBe(false);
    expect(wait.safeParse({ threadId: "thread-1", agentIds: ["   "] }).success).toBe(false);
    expect(
      wait.safeParse({ threadId: "thread-1", agentIds: ["agent-1"], timeoutMs: -1 }).success,
    ).toBe(false);
    expect(
      wait.safeParse({ threadId: "thread-1", agentIds: ["agent-1"], timeoutMs: 1.5 }).success,
    ).toBe(false);
    expect(
      wait.safeParse({ threadId: "thread-1", agentIds: ["agent-1"], mode: "both" }).success,
    ).toBe(false);
    expect(
      wait.safeParse({ threadId: "thread-1", agentIds: ["agent-1"], extra: true }).success,
    ).toBe(false);
  });

  test("input, inspect, resume, close, and list reject blank ids and extras", () => {
    expect(
      sendInput.parse({
        threadId: "thread-1",
        agentId: "agent-1",
        message: " continue ",
      }),
    ).toEqual({
      threadId: "thread-1",
      agentId: "agent-1",
      message: "continue",
    });
    expect(
      sendInput.safeParse({
        threadId: "thread-1",
        agentId: "agent-1",
        message: "continue",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      sendInput.safeParse({
        threadId: "thread-1",
        agentId: "agent-1",
        message: "   ",
      }).success,
    ).toBe(false);
    expect(inspect.safeParse({ threadId: "thread-1", agentId: "  " }).success).toBe(false);
    expect(
      inspect.safeParse({ threadId: "thread-1", agentId: "agent-1", extra: true }).success,
    ).toBe(false);
    expect(
      resume.safeParse({ threadId: "thread-1", agentId: "agent-1", extra: true }).success,
    ).toBe(false);
    expect(close.safeParse({ threadId: "thread-1", agentId: "agent-1", extra: true }).success).toBe(
      false,
    );
    expect(list.safeParse({ threadId: "   " }).success).toBe(false);
    expect(list.safeParse({ threadId: "thread-1", extra: true }).success).toBe(false);
  });

  test("empty-object results reject extras and wait-result notifications require agent ids", () => {
    expect(jsonRpcAgentResultSchemas["cowork/session/agent/spawn"].parse({})).toEqual({});
    expect(
      jsonRpcAgentResultSchemas["cowork/session/agent/spawn"].safeParse({ extra: true }).success,
    ).toBe(false);
    expect(
      jsonRpcAgentResultSchemas["cowork/session/agent/wait"].safeParse({ extra: true }).success,
    ).toBe(false);
    expect(
      jsonRpcAgentNotificationSchemas["cowork/session/agentWaitResult"].safeParse({
        type: "agent_wait_result",
        sessionId: "thread-1",
        agentIds: [],
        timedOut: false,
        mode: "any",
        agents: [],
        readyAgentIds: [],
      }).success,
    ).toBe(false);
    expect(
      jsonRpcAgentNotificationSchemas["cowork/session/agentWaitResult"].safeParse({
        type: "agent_wait_result",
        sessionId: "thread-1",
        agentIds: ["agent-1"],
        timedOut: false,
        mode: "race",
        agents: [],
        readyAgentIds: [],
      }).success,
    ).toBe(false);
  });
});
