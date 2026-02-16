import { describe, expect, test } from "bun:test";

import { mapModelStreamChunk } from "../src/client/modelStream";

type ProviderCase = {
  provider: "openai" | "google" | "anthropic" | "codex-cli";
  model: string;
  reasoningSdkType: string;
  expectedReasoningMode: "summary" | "reasoning";
};

const PROVIDER_CASES: ProviderCase[] = [
  {
    provider: "openai",
    model: "gpt-5.2",
    reasoningSdkType: "response.reasoning_summary_text.delta",
    expectedReasoningMode: "summary",
  },
  {
    provider: "google",
    model: "gemini-2.5-pro",
    reasoningSdkType: "response.reasoning_text.delta",
    expectedReasoningMode: "reasoning",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4",
    reasoningSdkType: "response.reasoning_text.delta",
    expectedReasoningMode: "reasoning",
  },
  {
    provider: "codex-cli",
    model: "gpt-5-codex",
    reasoningSdkType: "response.reasoning_summary_text.delta",
    expectedReasoningMode: "summary",
  },
];

describe("model stream parser provider/model loop coverage", () => {
  for (const entry of PROVIDER_CASES) {
    test(`${entry.provider}/${entry.model} raw/unknown events parse into readable updates`, () => {
      const base = {
        type: "model_stream_chunk" as const,
        sessionId: "s1",
        turnId: "turn-loop",
        provider: entry.provider,
        model: entry.model,
      };

      const reasoning = mapModelStreamChunk({
        ...base,
        index: 0,
        partType: "unknown",
        part: {
          sdkType: entry.reasoningSdkType,
          raw: { item_id: "r-loop", delta: "thinking..." },
        },
      });
      expect(reasoning).toEqual({
        kind: "reasoning_delta",
        turnId: "turn-loop",
        streamId: "r-loop",
        mode: entry.expectedReasoningMode,
        text: "thinking...",
      });

      const toolDelta = mapModelStreamChunk({
        ...base,
        index: 1,
        partType: "raw",
        part: {
          raw: {
            type: "response.function_call_arguments.delta",
            item_id: "fc-loop",
            delta: "{\"question\":\"Proceed?\"}",
          },
        },
      });
      expect(toolDelta).toEqual({
        kind: "tool_input_delta",
        turnId: "turn-loop",
        key: "fc-loop",
        delta: "{\"question\":\"Proceed?\"}",
      });

      const completed = mapModelStreamChunk({
        ...base,
        index: 2,
        partType: "unknown",
        part: {
          sdkType: "response.completed",
          raw: { response: { status: "completed" } },
        },
      });
      expect(completed).toEqual({
        kind: "turn_finish",
        turnId: "turn-loop",
        finishReason: "completed",
        rawFinishReason: undefined,
        totalUsage: undefined,
      });
    });
  }
});
