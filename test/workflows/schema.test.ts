import { describe, expect, test } from "bun:test";
import {
  workflowAgentCallSchema,
  workflowHostMessageSchema,
  workflowMetaSchema,
} from "../../src/workflows/schema";

const rejectsAll = (
  schema: { safeParse: (v: unknown) => { success: boolean } },
  cases: unknown[],
) => {
  for (const value of cases) expect(schema.safeParse(value).success).toBe(false);
};

describe("workflow sandbox schemas", () => {
  test("host messages reject unknown types, missing payloads, and extras", () => {
    rejectsAll(workflowHostMessageSchema, [
      { t: "bogus" },
      { t: "agent", callId: 0 },
      { t: "agent", callId: -1, payload: "{}" },
      { t: "log", message: "ok", extra: true },
      { t: "phase", title: "x".repeat(201) },
      { t: "log", message: "x".repeat(2_001) },
    ]);
    expect(workflowHostMessageSchema.parse({ t: "done", result: { ok: true } })).toEqual({
      t: "done",
      result: { ok: true },
    });
    expect(
      workflowHostMessageSchema.parse({ t: "agent", callId: 0, payload: '{"prompt":"x"}' }),
    ).toEqual({ t: "agent", callId: 0, payload: '{"prompt":"x"}' });
  });

  test("agent calls require briefing for brief isolation and bound timeoutMs", () => {
    rejectsAll(workflowAgentCallSchema, [
      { prompt: "x", opts: { isolation: "brief" } },
      { prompt: "x", opts: { isolation: "brief", briefing: " " } },
      { prompt: "x", opts: { timeoutMs: 500 } },
      { prompt: "x", opts: { timeoutMs: 3_600_001 } },
      { prompt: " ", opts: {} },
      { prompt: "x", opts: { inputFormat: "bad format" } },
    ]);
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
    rejectsAll(workflowMetaSchema, [
      { name: "demo", description: "demo flow", phases: [] },
      { name: " ", description: "demo flow", phases: ["one"] },
      { name: "demo", description: "demo flow", phases: ["one"], extra: true },
    ]);
    expect(
      workflowMetaSchema.parse({ name: " demo ", description: " demo flow ", phases: [" one "] }),
    ).toEqual({ name: "demo", description: "demo flow", phases: ["one"] });
  });
});
