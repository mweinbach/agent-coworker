import { describe, test, expect } from "bun:test";

import { createA2uiTool } from "../../src/tools/a2ui";
import type { ToolContext } from "../../src/tools/context";
import type { AgentConfig } from "../../src/types";

function createMockContext(overrides?: Partial<ToolContext>): {
  ctx: ToolContext;
  logs: string[];
  applied: Array<unknown>;
} {
  const logs: string[] = [];
  const applied: Array<unknown> = [];
  const ctx: ToolContext = {
    config: {
      provider: "google",
      model: "gemini-3-flash-preview",
      workingDirectory: "/tmp",
    } as unknown as AgentConfig,
    log: (line) => logs.push(line),
    askUser: async () => "",
    approveCommand: async () => true,
    applyA2uiEnvelope: (envelope) => {
      applied.push(envelope);
      return { ok: true, surfaceId: "s1", change: "created" };
    },
    ...overrides,
  };
  return { ctx, logs, applied };
}

describe("a2ui tool", () => {
  test("throws when A2UI is not enabled", async () => {
    const { ctx } = createMockContext({ applyA2uiEnvelope: undefined });
    const tool = createA2uiTool(ctx);
    await expect(
      tool.execute({
        envelopes: [
          { version: "v0.9", createSurface: { surfaceId: "s", catalogId: "c" } },
        ],
      }),
    ).rejects.toThrow(/A2UI is not enabled/);
  });

  test("forwards each envelope to the context hook and returns a summary", async () => {
    const { ctx, applied } = createMockContext();
    const tool = createA2uiTool(ctx);
    const envelope = {
      version: "v0.9",
      createSurface: {
        surfaceId: "s1",
        catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
      },
    };
    const result = (await tool.execute({ envelopes: [envelope] })) as {
      applied: number;
      failed: number;
      results: Array<{ ok: boolean }>;
    };
    expect(applied).toEqual([envelope]);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.results).toHaveLength(1);
  });

  test("returns failures without throwing when the applier reports an error", async () => {
    const { ctx } = createMockContext({
      applyA2uiEnvelope: () => ({ ok: false, error: "kaboom" }),
    });
    const tool = createA2uiTool(ctx);
    const result = (await tool.execute({
      envelopes: [
        { version: "v0.9", deleteSurface: { surfaceId: "ghost" } },
      ],
    })) as { applied: number; failed: number; results: Array<{ error?: string }> };
    expect(result.applied).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.results[0]!.error).toBe("kaboom");
  });
});
