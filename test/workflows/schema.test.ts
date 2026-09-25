import { describe, expect, test } from "bun:test";

import {
  workflowAgentCallSchema,
  workflowHostMessageSchema,
  workflowMetaSchema,
} from "../../src/workflows/schema";

function rejects(schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false);
}

describe("workflow sandbox schemas", () => {
  test("host messages reject unknown types, missing payloads, and extras", () => {
    rejects(workflowHostMessageSchema, { t: "bogus" });
    rejects(workflowHostMessageSchema, { t: "agent", callId: 0 });
    rejects(workflowHostMessageSchema, { t: "agent", callId: -1, payload: "{}" });
    rejects(workflowHostMessageSchema, { t: "log", message: "ok", extra: true });
    rejects(workflowHostMessageSchema, { t: "phase", title: "x".repeat(201) });
    rejects(workflowHostMessageSchema, { t: "log", message: "x".repeat(2_001) });

    expect(workflowHostMessageSchema.parse({ t: "done", result: { ok: true } })).toEqual({
      t: "done",
      result: { ok: true },
    });
    expect(
      workflowHostMessageSchema.parse({ t: "agent", callId: 0, payload: '{"prompt":"x"}' }),
    ).toEqual({
      t: "agent",
      callId: 0,
      payload: '{"prompt":"x"}',
    });
  });

  test("agent calls require briefing for brief isolation and bound timeoutMs", () => {
    rejects(workflowAgentCallSchema, { prompt: "x", opts: { isolation: "brief" } });
    rejects(workflowAgentCallSchema, { prompt: "x", opts: { isolation: "brief", briefing: " " } });
    rejects(workflowAgentCallSchema, { prompt: "x", opts: { timeoutMs: 500 } });
    rejects(workflowAgentCallSchema, { prompt: "x", opts: { timeoutMs: 3_600_001 } });
    rejects(workflowAgentCallSchema, { prompt: " ", opts: {} });
    rejects(workflowAgentCallSchema, { prompt: "x", opts: { inputFormat: "bad format" } });

    expect(
      workflowAgentCallSchema.parse({
        prompt: "  do the work  ",
        opts: { isolation: "brief", briefing: " stay in src/ " },
      }),
    ).toEqual({
      prompt: "do the work",
      opts: {
        isolation: "brief",
        briefing: "stay in src/",
        onError: "fail",
        timeoutMs: 600_000,
      },
    });
  });

  test("workflow meta requires at least one phase and rejects extras", () => {
    rejects(workflowMetaSchema, { name: "demo", description: "demo flow", phases: [] });
    rejects(workflowMetaSchema, { name: " ", description: "demo flow", phases: ["one"] });
    rejects(workflowMetaSchema, {
      name: "demo",
      description: "demo flow",
      phases: ["one"],
      extra: true,
    });

    expect(
      workflowMetaSchema.parse({
        name: " demo ",
        description: " demo flow ",
        phases: [" one "],
      }),
    ).toEqual({
      name: "demo",
      description: "demo flow",
      phases: ["one"],
    });
  });
});
